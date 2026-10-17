import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { Host } from "./hosts.js";
import { Store } from "./store.js";
import {
  taskKey,
  BriefingFeedbackRating,
  Config,
  Project,
  ShadowAnalysisConfig,
  Task,
  WorkItem,
} from "./types.js";
import {
  coordinate,
  type CoordinatorExecution,
  type CoordinatorPlan,
} from "./coordinator.js";
import {
  boundDetailMessages,
  createAdapter,
  SourceAdapter,
} from "./adapters.js";
import { RuntimeMonitor } from "./runtime.js";
import { demoGit, demoWorkspace, seedDemoStore } from "./demo.js";
import { policyAction, policyDecision, type PolicyActor } from "./policy.js";
import { buildTaskBriefing, buildWorkspaceBriefing } from "./briefing.js";
import {
  analyzeShadowWork,
  buildShadowPrompt,
  type ShadowRunner,
} from "./shadow-analysis.js";

function checkoutName(path: string) {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  const last = parts.at(-1) || path;
  return last === "project" && parts.length > 1 ? parts.at(-2)! : last;
}

export class Engine extends EventEmitter {
  hosts: Host[];
  adapters: SourceAdapter[];
  runtime: RuntimeMonitor;
  timer?: NodeJS.Timeout;
  shadowTimer?: NodeJS.Timeout;
  chatBusy = false;
  shadowBusy = false;
  shadowLastError = "";
  shadowRunner: ShadowRunner = analyzeShadowWork;
  stopping = false;
  modelCatalogs: Record<string, any[]> = {};
  private sourceRefreshes = new Map<string, Promise<void>>();
  private openClawLastRefresh = 0;
  constructor(
    public config: Config,
    public store: Store,
    public root: string,
  ) {
    super();
    this.hosts = config.hosts.map((c) => new Host(c, root));
    this.adapters = (config.sources || [])
      .filter((source) => source.enabled !== false)
      .map(createAdapter);
    this.runtime = new RuntimeMonitor(config.runtime);
    store.recover();
    if (config.mode === "demo") seedDemoStore(store);
    for (const h of this.hosts) {
      h.rpc.on("event", (e, g) => this.event(h, e, g));
      h.rpc.on("disconnect", () => {
        store.expireApprovals(h.config.id);
        this.emit("change");
      });
    }
    for (const adapter of this.adapters) {
      adapter.on("invalidate", () => {
        this.emit("invalidation", {
          sourceId: adapter.config.id,
          pages: ["work", "runtime"],
        });
        if (adapter.config.adapter === "openclaw")
          setTimeout(
            () =>
              void this.refreshSource(adapter)
                .then(() =>
                  this.emit("invalidation", {
                    sourceId: adapter.config.id,
                    pages: ["work", "runtime", "inbox"],
                  }),
                )
                .catch(() =>
                  this.emit("invalidation", {
                    sourceId: adapter.config.id,
                    pages: ["runtime"],
                  }),
                ),
            250,
          ).unref();
      });
      adapter.on("action", (event: any) => {
        const workId = event.sessionKey
          ? store.workForSession(adapter.config.id, event.sessionKey)
          : null;
        store.action(
          event.kind,
          event.title,
          event.body,
          workId,
          `${adapter.config.id}:${event.eventId}`,
          { sourceId: adapter.config.id, sessionKey: event.sessionKey },
        );
        this.emit("invalidation", {
          sourceId: adapter.config.id,
          pages: ["inbox", "runtime"],
        });
      });
    }
  }
  host(id: string) {
    const h = this.hosts.find((h) => h.config.id === id);
    if (!h) throw new Error("Unknown machine");
    return h;
  }
  task(key: string) {
    const t = this.store.task(key);
    if (!t) throw new Error("Task not found");
    return t;
  }
  private sourceStaleAfter(adapter: SourceAdapter) {
    if (adapter.config.adapter === "openclaw")
      return Math.max(90000, (adapter.config.reconcileSeconds || 60) * 1500);
    return adapter.config.adapter === "hermes" ? 180000 : 45000;
  }
  start() {
    if (this.config.mode === "demo") {
      this.emit("change");
      return;
    }
    const initial = this.refresh(true);
    this.timer = setInterval(() => void this.refresh(false), 12000);
    const shadow = this.shadowConfig();
    if (shadow.enabled) {
      void initial.then(() => this.runShadowCycle());
      this.shadowTimer = setInterval(
        () => void this.runShadowCycle(),
        shadow.intervalSeconds * 1000,
      );
    }
  }
  async refresh(force = false) {
    if (this.config.mode === "demo") {
      this.emit("change");
      return;
    }
    const now = Date.now(),
      sources = this.adapters.filter(
        (adapter) =>
          adapter.config.adapter !== "openclaw" ||
          force ||
          now - this.openClawLastRefresh >= 60000,
      );
    if (sources.some((adapter) => adapter.config.adapter === "openclaw"))
      this.openClawLastRefresh = now;
    await Promise.allSettled([
      ...this.hosts.map((h) => this.refreshHost(h)),
      ...sources.map((adapter) => this.refreshSource(adapter)),
      this.runtime.refresh(),
    ]);
    this.emit("change");
  }
  async refreshSource(adapter: SourceAdapter) {
    const existing = this.sourceRefreshes.get(adapter.config.id);
    if (existing) return existing;
    const job = (async () => {
      try {
        const observations = await adapter.inventory(),
          seen: string[] = [],
          localModels = new Set(
            this.runtime.snapshot.catalog
              .filter(
                (model) =>
                  model.locality === "local" &&
                  model.provider !== "astra-router" &&
                  !/smart router/i.test(String(model.id || "")),
              )
              .map((model) => String(model.id).toLowerCase()),
          );
        for (const observation of observations) {
          const execution = observation.item.execution,
            reportedModel = execution.resolvedModel || execution.requestedModel;
          if (
            execution.locality === "unknown" &&
            reportedModel &&
            localModels.has(reportedModel.toLowerCase())
          )
            observation.item.execution = { ...execution, locality: "local" };
          seen.push(observation.source.nativeId);
          const previous = this.store.sourceObservation(
              observation.source.adapter,
              observation.source.sourceId,
              observation.source.nativeId,
            ),
            workId = this.store.upsertSource(observation),
            work = this.store.workItem(workId),
            prefix = `state:${observation.source.adapter}:${observation.source.sourceId}:${observation.source.nativeId}:`,
            status = observation.item.status;
          if (status === "failed" || status === "waiting")
            this.store.reconcileStateAction(prefix, {
              kind: status === "failed" ? "failure" : "blocked",
              title:
                status === "failed"
                  ? "Source-reported failure"
                  : "Work is waiting for attention",
              body:
                observation.item.error ||
                observation.item.latestExcerpt ||
                (status === "failed"
                  ? "Open the source to inspect the failure."
                  : "Open the source to inspect what is blocking progress."),
              key: workId,
              fingerprint: `${prefix}${status}:${observation.item.updatedAt}`,
              payload: {
                sourceId: observation.source.sourceId,
                nativeId: observation.source.nativeId,
                status,
              },
            });
          else this.store.reconcileStateAction(prefix, null);
          if (observation.eventKind && observation.eventId)
            this.store.action(
              observation.eventKind,
              observation.eventKind === "approval"
                ? "Approval needs attention"
                : observation.eventKind === "completion"
                  ? "Background work completed"
                  : "Source reported a problem",
              observation.eventBody ||
                observation.item.latestExcerpt ||
                observation.item.title,
              workId,
              `${observation.source.sourceId}:${observation.eventId}`,
            );
          if (
            work?.watched &&
            observation.item.kind !== "conversation" &&
            previous &&
            ["active", "recent", "waiting"].includes(previous.item.status) &&
            ["completed", "idle"].includes(observation.item.status)
          )
            this.store.action(
              "completion",
              "Watched background work completed",
              observation.item.latestExcerpt ||
                "Review the latest result at its source.",
              workId,
              `completion:${observation.source.sourceId}:${observation.source.nativeId}:${observation.item.updatedAt}`,
            );
        }
        this.store.pruneSource(adapter.config.id, seen);
        this.store.setCursor(adapter.config.id, String(Date.now()));
        this.modelCatalogs[adapter.config.id] = await adapter.modelCatalog();
      } finally {
        this.sourceRefreshes.delete(adapter.config.id);
      }
    })();
    this.sourceRefreshes.set(adapter.config.id, job);
    return job;
  }
  async refreshMachine(id: string) {
    const h = this.host(id);
    await this.refreshHost(h, true);
    this.emit("change");
    return {
      online: h.online,
      lastSeen: h.lastSeen,
      error: h.error,
      runtimeConnected: h.rpc.ready,
      projectsError: h.projectsError,
      inventoryCount: h.inventoryCount,
    };
  }
  async refreshHost(h: Host, forceProjects = false) {
    if (h.polling || this.stopping) return;
    h.polling = true;
    try {
      const tasks = await h.snapshot();
      const missing = this.store
        .tasks()
        .filter(
          (t) =>
            t.hostId === h.config.id &&
            t.watched &&
            !tasks.some((x) => x.id === t.id),
        );
      for (const t of missing) tasks.push(...(await h.snapshot(t.id)));
      await h.refreshProjects(forceProjects);
      h.online = true;
      h.error = "";
      h.lastSeen = Date.now();
      h.inventoryCount = tasks.length;
      for (const t of tasks) this.ingest(t);
      this.store.pruneSource(
        `codex-${h.config.id}`,
        tasks.map((task) => task.id),
      );
    } catch (e) {
      h.online = false;
      h.error = (e as Error).message;
    } finally {
      h.polling = false;
    }
  }
  ingest(t: Task) {
    const previous = this.store.task(t.key);
    this.store.upsert(t);
    const prefix = `state:codex:codex-${t.hostId}:${t.id}:`,
      waiting =
        t.turnStatus === "interrupted" ||
        t.status === "paused" ||
        (t.turnStatus === "inProgress" && t.status !== "running"),
      failed = t.turnStatus === "failed" || t.status === "failed";
    if (failed || waiting)
      this.store.reconcileStateAction(prefix, {
        kind: failed ? "failure" : "blocked",
        title: failed
          ? "Task needs attention"
          : t.turnStatus === "interrupted"
            ? "Task was interrupted"
            : "Task has no active writer",
        body:
          t.error ||
          t.latest?.text?.slice(0, 2000) ||
          (failed
            ? "Open the task to inspect the failure."
            : "Open the task to inspect or resume it."),
        key: t.key,
        fingerprint: `${prefix}${failed ? "failed" : "waiting"}:${t.turnId || t.updatedAt}`,
        payload: {
          hostId: t.hostId,
          threadId: t.id,
          turnId: t.turnId,
          status: t.turnStatus || t.status,
        },
      });
    else this.store.reconcileStateAction(prefix, null);
    if (
      previous?.watched &&
      t.turnId &&
      t.turnStatus &&
      (previous.turnId !== t.turnId || previous.turnStatus !== t.turnStatus)
    ) {
      if (t.turnStatus === "completed")
        this.store.action(
          "completion",
          "Agent finished a turn",
          t.latest?.text?.slice(0, 5000) ||
            "Review the result and decide what comes next.",
          t.key,
          `completion:${t.key}:${t.turnId}`,
        );
      if (t.turnStatus === "failed" || t.turnStatus === "interrupted")
        this.store.action(
          "failure",
          t.turnStatus === "failed" ? "Task needs attention" : "Task paused",
          t.error ||
            t.latest?.text?.slice(0, 2000) ||
            "Open the task to inspect its latest state.",
          t.key,
          `failure:${t.key}:${t.turnId}:${t.turnStatus}`,
        );
    }
  }
  projects() {
    if (this.config.mode === "demo") return demoWorkspace().projects;
    const tasks = this.store.tasks(),
      result: Project[] = [];
    for (const h of this.hosts) {
      const hostTasks = tasks.filter((t) => t.hostId === h.config.id),
        claimed = new Set<string>();
      for (const project of h.projects) {
        const roots = [
          ...new Set([
            ...project.roots,
            ...hostTasks
              .filter((t) => t.projectId === project.id)
              .map((t) => t.cwd),
          ]),
        ];
        roots.forEach((root) => claimed.add(root));
        result.push({ ...project, roots });
      }
      for (const cwd of [...new Set(hostTasks.map((t) => t.cwd))])
        if (!claimed.has(cwd))
          result.push({
            id: null,
            hostId: h.config.id,
            name: checkoutName(cwd),
            roots: [cwd],
            source: "history",
          });
    }
    return result;
  }
  private shadowConfig() {
    const config: ShadowAnalysisConfig = this.config.shadowAnalysis || {};
    return {
      ...config,
      enabled: config.enabled === true,
      model: String(config.model || "gpt-5.6-luna").slice(0, 120),
      reasoningEffort: config.reasoningEffort || "medium",
      intervalSeconds: Math.max(
        60,
        Math.min(86400, Number(config.intervalSeconds || 900)),
      ),
      dailyCallLimit: Math.max(
        1,
        Math.min(100, Number(config.dailyCallLimit || 20)),
      ),
      observableTokenLimit: Math.max(
        1000,
        Math.min(10000000, Number(config.observableTokenLimit || 100000)),
      ),
      maxExcerptChars: Math.max(
        500,
        Math.min(12000, Number(config.maxExcerptChars || 4000)),
      ),
      localOnlyProjects: Array.isArray(config.localOnlyProjects)
        ? config.localOnlyProjects.slice(0, 500)
        : [],
    };
  }
  private shadowEligible(item: WorkItem) {
    return (
      item.watched || ["active", "waiting", "failed"].includes(item.status)
    );
  }
  private shadowLocalOnly(item: WorkItem) {
    return this.shadowConfig().localOnlyProjects.some((boundary) => {
      if (!boundary || boundary.hostId !== item.hostId) return false;
      if (Object.prototype.hasOwnProperty.call(boundary, "projectId"))
        return (boundary.projectId ?? null) === (item.projectId ?? null);
      if (boundary.root) {
        const root = boundary.root.replace(/[\\/]+$/, "");
        return item.cwd === root || item.cwd.startsWith(`${root}/`);
      }
      return false;
    });
  }
  private shadowCandidateBriefs() {
    const actions = this.store.openActions(),
      proposals = this.store.coordinatorProposals(),
      feedback = this.store.briefingFeedback();
    return this.store
      .briefingCandidates(1000)
      .map((raw) => {
        const item = this.withAvailability(raw);
        return {
          item,
          brief: buildTaskBriefing(item, actions, proposals, feedback),
        };
      })
      .filter(({ item }) => this.shadowEligible(item))
      .sort((a, b) => {
        const score = (item: WorkItem) =>
          item.status === "failed"
            ? 100
            : item.status === "waiting"
              ? 90
              : item.status === "active"
                ? 80
                : item.watched
                  ? 60
                  : 0;
        return score(b.item) - score(a.item) || b.item.updatedAt - a.item.updatedAt;
      });
  }
  shadowAnalysisState() {
    const config = this.shadowConfig(),
      analyses = this.store.shadowAnalyses(),
      completed = new Set(
        analyses.map(
          (analysis) => `${analysis.task_key}\0${analysis.evidence_revision}`,
        ),
      ),
      pending = this.shadowCandidateBriefs().filter(
        ({ item, brief }) =>
          !completed.has(`${item.key}\0${brief.evidenceRevision}`),
      ),
      blockedLocal = pending.filter(({ item }) =>
        this.shadowLocalOnly(item),
      ).length,
      metrics = this.store.shadowMetrics(),
      observableTokens =
        metrics.today.inputTokens + metrics.today.outputTokens,
      budgetExhausted =
        metrics.today.calls >= config.dailyCallLimit ||
        observableTokens >= config.observableTokenLimit;
    return {
      enabled: config.enabled,
      mode: "proposal-only",
      busy: this.shadowBusy,
      status: !config.enabled
        ? "disabled"
        : this.shadowBusy
          ? "analyzing"
          : budgetExhausted
            ? "budget-exhausted"
            : pending.length === blockedLocal && pending.length > 0
              ? "local-route-required"
              : "ready",
      model: config.model,
      route: "codex-subscription",
      lastError: this.shadowLastError,
      pending: pending.length - blockedLocal,
      blockedLocal,
      limits: {
        dailyCalls: config.dailyCallLimit,
        observableTokens: config.observableTokenLimit,
        maxExcerptChars: config.maxExcerptChars,
        intervalSeconds: config.intervalSeconds,
      },
      ...metrics,
      recent: analyses.slice(0, 12).map((analysis) => ({
        id: analysis.id,
        taskKey: analysis.task_key,
        evidenceRevision: analysis.evidence_revision,
        status: analysis.status,
        model: analysis.model,
        title: analysis.title,
        recommendation: analysis.recommendation,
        confidence: analysis.confidence,
        latencyMs: analysis.latency_ms,
        inputTokens: analysis.input_tokens,
        outputTokens: analysis.output_tokens,
        error: analysis.error,
        createdAt: analysis.created_at,
      })),
    };
  }
  async runShadowCycle() {
    const config = this.shadowConfig();
    if (!config.enabled || this.config.mode === "demo" || this.stopping)
      return { started: false, reason: "disabled" };
    if (this.shadowBusy) return { started: false, reason: "busy" };
    this.shadowBusy = true;
    this.shadowLastError = "";
    this.emit("change");
    let reservation: { accepted: boolean; reason: string; id: string } | undefined,
      started = Date.now();
    try {
      const analyses = this.store.shadowAnalyses(),
        completed = new Set(
          analyses.map(
            (analysis) => `${analysis.task_key}\0${analysis.evidence_revision}`,
          ),
        ),
        candidate = this.shadowCandidateBriefs().find(
          ({ item, brief }) =>
            !this.shadowLocalOnly(item) &&
            !completed.has(`${item.key}\0${brief.evidenceRevision}`),
        );
      if (!candidate) return { started: false, reason: "no-eligible-evidence" };
      const local = this.hosts.find((host) => !host.config.ssh);
      if (!local) throw new Error("A local Codex analysis route is required");
      const prompt = buildShadowPrompt(
        candidate.item,
        candidate.brief,
        config.maxExcerptChars,
      );
      reservation = this.store.reserveShadowAnalysis(
        candidate.item.key,
        candidate.brief.evidenceRevision,
        "codex-subscription",
        config.model,
        prompt.length,
        config.dailyCallLimit,
        config.observableTokenLimit,
      );
      if (!reservation.accepted)
        return { started: false, reason: reservation.reason };
      const result = await this.shadowRunner(
        local.config.codex,
        this.root,
        prompt,
        config,
      );
      this.store.finishShadowAnalysis(reservation.id, result);
      return { started: true, id: reservation.id, status: "succeeded" };
    } catch (error) {
      const message = String((error as Error).message || "Shadow analysis failed")
        .replace(/(bearer|api[_ -]?key|token|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
        .slice(0, 1000);
      this.shadowLastError = message;
      if (reservation?.accepted)
        this.store.failShadowAnalysis(
          reservation.id,
          message,
          Date.now() - started,
        );
      return { started: true, id: reservation?.id, status: "failed", error: message };
    } finally {
      this.shadowBusy = false;
      this.emit("change");
    }
  }
  triggerShadowAnalysis() {
    const config = this.shadowConfig();
    if (!config.enabled) throw new Error("Shadow analysis is not enabled");
    if (this.shadowBusy) return { queued: false, reason: "busy" };
    void this.runShadowCycle();
    return { queued: true };
  }
  state() {
    const actions = this.store.actions(),
      inboxItems = [
        ...new Set(
          actions
            .filter((action) => action.status !== "resolved" && action.task_key)
            .map((action) => String(action.task_key)),
        ),
      ].flatMap((id) => {
        const item = this.store.workItem(id);
        return item ? [this.withAvailability(item)] : [];
      }),
      providerSummary = this.store.workProviders(),
      demo = this.config.mode === "demo" ? demoWorkspace() : null,
      runtime = {
        ...(demo?.runtime || this.runtime.snapshot),
        providers: [
          ...new Set([
            ...(demo?.runtime.providers || this.runtime.snapshot.providers),
            ...providerSummary.map((row) => row.provider),
          ]),
        ],
        providerSummary,
      },
      briefing = this.briefing();
    return {
      supervisorName:
        this.config.supervisorName?.trim().slice(0, 60) || "Astra",
      baselines: { decision: this.store.decisionBaseline() },
      shadowAnalysis: this.shadowAnalysisState(),
      briefing,
      summary: this.store.workSummary(),
      projects: demo?.projects || this.projects(),
      hosts:
        demo?.hosts ||
        this.hosts.map((h) => ({
          id: h.config.id,
          name: h.config.name,
          online: h.online,
          lastSeen: h.lastSeen,
          error: h.error,
          runtimeConnected: h.rpc.ready,
          controlAvailable: h.rpc.controlAvailable,
          controlError: h.rpc.controlError,
          protocolVersion: h.rpc.protocolVersion,
          projectsError: h.projectsError,
          inventoryCount: h.inventoryCount,
        })),
      sources:
        demo?.sources ||
        this.adapters.map((adapter) => ({
          ...adapter.health,
          stale:
            adapter.health.lastSeen === 0 ||
            Date.now() - adapter.health.lastSeen >
              this.sourceStaleAfter(adapter),
          models: this.modelCatalogs[adapter.config.id] || [],
        })),
      runtime,
      inboxItems,
      actions,
      commands: this.store.commands(),
      chat: this.store.chat(),
      chatBusy: this.chatBusy,
      now: Date.now(),
      ...(demo ? { demo: demo.demo } : {}),
    };
  }
  workItems(query: any = {}) {
    const result = this.store.workItems(query),
      actions = this.store.openActions(),
      proposals = this.store.coordinatorProposals(),
      feedback = this.store.briefingFeedback(),
      analyses = this.store.unappliedShadowAnalyses();
    return {
      ...result,
      items: result.items.map((item) => {
        const available = this.withAvailability(item);
        return {
          ...available,
          briefing: buildTaskBriefing(
            available,
            actions,
            proposals,
            feedback,
            analyses,
          ),
        };
      }),
    };
  }
  briefing() {
    const actions = this.store.openActions(),
      candidates = this.store.briefingCandidates(),
      present = new Map(candidates.map((item) => [item.key, item]));
    for (const action of actions) {
      if (!action.task_key || present.has(action.task_key)) continue;
      const item = this.store.workItem(String(action.task_key));
      if (item) present.set(item.key, item);
    }
    return buildWorkspaceBriefing(
      [...present.values()].map((item) => this.withAvailability(item)),
      actions,
      this.store.coordinatorProposals(),
      this.store.briefingFeedback(),
      Date.now(),
      this.store.unappliedShadowAnalyses(),
    );
  }
  rateRecommendation(
    recommendationId: string,
    evidenceRevision: string,
    taskKey: string | null,
    rating: BriefingFeedbackRating,
  ) {
    let recommendation;
    if (taskKey) {
      const item = this.store.workItem(taskKey);
      if (!item) throw new Error("Recommendation task no longer exists");
      recommendation = buildTaskBriefing(
        this.withAvailability(item),
        this.store.openActions(),
        this.store.coordinatorProposals(),
        this.store.briefingFeedback(),
        this.store.unappliedShadowAnalyses(),
      ).recommendation;
    } else {
      recommendation = this.briefing().recommendations.items.find(
        (entry) => entry.id === recommendationId,
      );
    }
    if (
      !recommendation ||
      recommendation.id !== recommendationId ||
      recommendation.evidenceRevision !== evidenceRevision
    )
      throw new Error("This recommendation is stale; refresh the briefing");
    const saved = this.store.saveBriefingFeedback(
      recommendationId,
      evidenceRevision,
      taskKey,
      rating,
    );
    this.emit("change");
    return saved;
  }
  async applyRecommendation(
    requestId: string,
    recommendationId: string,
    evidenceRevision: string,
    taskKey?: string | null,
  ) {
    const appliedShadow = this.store.shadowAnalysis(recommendationId);
    if (
      appliedShadow?.evidence_revision === evidenceRevision &&
      this.store.shadowAnalysisApplied(recommendationId, evidenceRevision)
    )
      return {
        status: "accepted",
        summary: "This recommendation was already applied.",
      };
    const appliedProposal = this.store.coordinatorProposal(recommendationId);
    if (
      appliedProposal?.status === "executed" &&
      appliedProposal.evidence_revision === evidenceRevision
    )
      return {
        status: "accepted",
        summary: "This recommendation was already applied.",
      };
    let recommendation;
    if (taskKey) {
      const item = this.store.workItem(taskKey);
      if (!item) throw new Error("Recommendation task no longer exists");
      recommendation = buildTaskBriefing(
        this.withAvailability(item),
        this.store.openActions(),
        this.store.coordinatorProposals(),
        this.store.briefingFeedback(),
        this.store.unappliedShadowAnalyses(),
      ).recommendation;
    } else
      recommendation = this.briefing().recommendations.items.find(
        (entry) => entry.id === recommendationId,
      );
    if (
      !recommendation ||
      recommendation.id !== recommendationId ||
      recommendation.evidenceRevision !== evidenceRevision ||
      recommendation.source !== "model" ||
      recommendation.isAdvice === false
    )
      throw new Error("This recommendation is stale; refresh the briefing");
    if (recommendation.analysisMode === "coordinator")
      return this.applyCoordinatorRecommendation(
        requestId,
        recommendationId,
        evidenceRevision,
      );
    if (!taskKey) throw new Error("This recommendation needs a task");
    const category = String(
      recommendation.evidence
        .find((line) => line.startsWith("Category:"))
        ?.slice("Category:".length)
        .trim() || "",
    );
    let result: any,
      summary = "Astra will keep this work visible for its next update.";
    if (category === "continue") {
      result = await this.continueTask(requestId, taskKey);
      summary = "The task was told to continue from its last safe checkpoint.";
    } else if (category === "inspect") {
      result = await this.send(
        requestId,
        taskKey,
        "Review the latest result and interruption details. Report what stopped the work and the safest next action. Do not resume implementation or make changes until the owner gives a new instruction.",
      );
      summary = "Astra was asked to inspect the interruption and report the safest next action.";
    } else if (category === "resolve-decision") {
      if (recommendation.actionId)
        return {
          status: "decision-needed",
          actionId: recommendation.actionId,
          summary: "Review the exact decision before the task can continue.",
        };
      result = await this.send(
        requestId,
        taskKey,
        "Review the current blocker and ask the owner one specific question needed to continue. Do not make changes until that question is answered.",
      );
      summary = "Astra was asked to identify the one decision needed to continue.";
    } else if (category === "archive-candidate") {
      result = await this.archive(requestId, taskKey);
      summary = "The inactive task was archived. It can be restored in Codex if needed.";
    } else if (category === "move-model-candidate") {
      result = await this.send(
        requestId,
        taskKey,
        "Prepare a model-change plan for this task: explain the expected benefit, risks, and exact model choice. Do not change the model or make implementation changes until the owner approves the plan.",
      );
      summary = "Astra was asked to prepare a model-change plan without changing the task.";
    } else if (["wait", "watch", "keep"].includes(category)) {
      this.watch(taskKey, true);
    } else throw new Error("This recommendation has no safe action to run");
    this.store.applyShadowAnalysis(recommendationId, evidenceRevision);
    this.emit("change");
    return { status: "accepted", summary, result };
  }
  private async applyCoordinatorRecommendation(
    requestId: string,
    recommendationId: string,
    evidenceRevision: string,
  ) {
    const proposal = this.store.coordinatorProposal(recommendationId);
    if (
      !proposal ||
      proposal.status !== "proposed" ||
      proposal.evidence_revision !== evidenceRevision ||
      !proposal.action
    )
      throw new Error("This recommendation is stale; refresh the briefing");
    const action = proposal.action,
      actionClass = policyAction(action.type, action.decision);
    if (!actionClass || policyDecision("owner", actionClass) !== "allow")
      throw new Error("This recommendation cannot be executed here");
    let result: any,
      summary = "Recommendation applied.";
    if (action.type === "send") {
      result = await this.send(requestId, action.taskKey, action.prompt);
      summary = "Astra sent the recommended instruction to the task.";
    } else if (action.type === "interrupt") {
      result = await this.pause(requestId, action.taskKey);
      summary = "Astra requested that the active task pause.";
    } else if (action.type === "archive") {
      result = await this.archive(requestId, action.taskKey);
      summary = "Astra archived the inactive task.";
    } else if (action.type === "create") {
      result = await this.create(
        requestId,
        action.hostId,
        action.projectId || null,
        action.cwd,
        action.title,
        action.prompt,
        action.isolate !== false,
      );
      summary = "Astra started the recommended task.";
    } else if (action.type === "watch") {
      this.watch(action.taskKey, action.value === true);
      summary = action.value
        ? "Astra will keep this task visible for updates."
        : "Astra stopped watching this task.";
    } else if (action.type === "resolve") {
      this.store.resolveMany(action.actionIds || []);
      summary = "Astra marked the selected handled items complete.";
    } else if (action.type === "approval") {
      const answers = Object.fromEntries(
        (action.answers || []).map((answer: any) => [
          answer.questionId,
          answer.answer,
        ]),
      );
      result = this.approval(action.actionId, {
        action: action.decision,
        answers,
      });
      summary = "Astra submitted the exact decision in this recommendation.";
    } else if (action.type === "refresh") {
      await this.refresh(true);
      summary = "Astra refreshed the workspace evidence.";
    } else throw new Error("This recommendation cannot be executed here");
    this.store.setCoordinatorProposalStatus(recommendationId, "executed");
    this.emit("change");
    return { status: "accepted", summary, result };
  }
  private withAvailability(item: WorkItem) {
    if (this.config.mode === "demo") return item;
    const external = item.sourceRefs.filter(
        (source) => source.adapter !== "codex",
      ),
      codex = item.sourceRefs.filter((source) => source.adapter === "codex"),
      controlHost = codex.length
        ? this.hosts.find((host) => host.config.id === codex[0].hostId)
        : undefined,
      available =
        codex.some(
          (source) =>
            this.hosts.find((host) => host.config.id === source.hostId)?.online,
        ) ||
        external.some((source) => {
          const adapter = this.adapters.find(
              (adapter) => adapter.config.id === source.sourceId,
            ),
            health = adapter?.health;
          return (
            !!adapter &&
            !!health?.lastSeen &&
            Date.now() - health.lastSeen <= this.sourceStaleAfter(adapter)
          );
        }),
      projected = controlHost
        ? {
            ...item,
            controlAvailable: controlHost.rpc.controlAvailable,
            controlReason: controlHost.rpc.controlError,
          }
        : item;
    return available ? projected : { ...projected, status: "offline" as const };
  }
  private withBriefing(item: WorkItem) {
    const available = this.withAvailability(item);
    return {
      ...available,
      briefing: buildTaskBriefing(
        available,
        this.store.openActions(),
        this.store.coordinatorProposals(),
        this.store.briefingFeedback(),
        this.store.unappliedShadowAnalyses(),
      ),
    };
  }
  watch(key: string, value: boolean) {
    const work = this.store.workItem(key);
    if (!work) throw new Error("Work item not found");
    this.store.watch(key, value);
    const t = this.store.task(key);
    if (value && t?.turnStatus === "completed")
      this.store.action(
        "review",
        "Review latest result",
        t.latest?.text?.slice(0, 5000) ||
          "This task has a completed turn. Review its outcome.",
        key,
        `watch:${key}:${t.turnId}`,
      );
    this.emit("change");
  }
  async detail(key: string) {
    const work = this.store.workItem(key);
    if (!work) throw new Error("Work item not found");
    if (this.config.mode === "demo")
      return {
        task: this.withBriefing(work),
        messages: boundDetailMessages(work.messages),
        git: demoGit(key),
      };
    const codex = work.sourceRefs.find((source) => source.adapter === "codex");
    if (codex) {
      const t = this.task(key),
        h = this.host(t.hostId),
        tasks = await h.snapshot(t.id);
      if (!tasks[0])
        throw new Error("Task is no longer available on its machine");
      this.ingest(tasks[0]);
      const git = await h.git(t.id);
      return {
        task: this.withBriefing(this.store.workItem(key)!),
        messages: boundDetailMessages(tasks[0].messages),
        git,
      };
    }
    const source = work.sourceRefs[0],
      adapter = this.adapters.find(
        (value) => value.config.id === source.sourceId,
      );
    if (!adapter) throw new Error("Source connector is not configured");
    const detail = await adapter.detail(source.nativeId, source);
    return {
      task: this.withBriefing(work),
      messages: boundDetailMessages(detail.messages),
      git: {
        available: false,
        error: "Repository state is managed by the source system.",
      },
    };
  }
  async command(
    id: string,
    key: string,
    kind: string,
    body: any,
    run: () => Promise<any>,
    actor: PolicyActor = "owner",
  ) {
    const prior = this.store.command(id);
    if (prior) {
      if (
        prior.task_key !== key ||
        prior.kind !== kind ||
        prior.body !== JSON.stringify(body) ||
        prior.actor !== actor
      )
        throw new Error("Request ID was reused with a different action");
      return {
        status: prior.status,
        result: prior.result ? JSON.parse(prior.result) : null,
      };
    }
    this.store.beginCommand(id, key, kind, body, actor);
    try {
      const result = await run();
      this.store.finishCommand(id, "accepted", result);
      this.emit("change");
      return { status: "accepted", result };
    } catch (e) {
      const text = (e as Error).message;
      const status = /timed out|connection closed/i.test(text)
        ? "uncertain"
        : "failed";
      this.store.finishCommand(id, status, { error: text });
      this.store.action(
        "delivery",
        "Instruction needs attention",
        text,
        key || null,
        `delivery:${id}`,
      );
      this.emit("change");
      throw e;
    }
  }
  async send(id: string, key: string, prompt: string) {
    const t = this.task(key),
      h = this.host(t.hostId);
    return this.command(id, key, "message", { prompt }, async () => {
      const current = (await h.snapshot(t.id))[0];
      if (!current) throw new Error("Task not found on its machine");
      if (!t.managed) {
        if (current.owned)
          throw new Error(
            "This task is controlled by the Codex desktop app. Open it in Codex, or start a dashboard task in the same repo. The message was not sent.",
          );
        await h.rpc.call("thread/resume", { threadId: t.id });
        this.store.manage(key);
      } else {
        await h.rpc.call("thread/resume", { threadId: t.id });
      }
      const thread = await h.rpc.call("thread/read", {
        threadId: t.id,
        includeTurns: true,
      });
      const active = thread.thread?.turns?.findLast(
        (v: any) => v.status === "inProgress",
      );
      if (active)
        return h.rpc.call("turn/steer", {
          threadId: t.id,
          expectedTurnId: active.id,
          input: [{ type: "text", text: prompt }],
        });
      return h.rpc.call("turn/start", {
        threadId: t.id,
        input: [{ type: "text", text: prompt }],
      });
    });
  }
  async continueTask(id: string, key: string) {
    return this.send(
      id,
      key,
      "Continue the task from its last safe checkpoint. Do not repeat a previously pending operation or treat an expired approval as permission. Request a new approval before any action that needs one.",
    );
  }
  async create(
    id: string,
    hostId: string,
    projectId: string | null,
    cwd: string,
    title: string,
    prompt: string,
    isolate = false,
  ) {
    const h = this.host(hostId),
      tasks = this.store.tasks().filter((t) => t.hostId === hostId);
    const project = projectId
      ? h.projects.find((p) => p.id === projectId)
      : undefined;
    const roots = project
      ? [
          ...new Set([
            ...project.roots,
            ...tasks.filter((t) => t.projectId === projectId).map((t) => t.cwd),
          ]),
        ]
      : [];
    if (projectId && !project)
      throw new Error("Choose a saved project on this machine");
    if (project && !roots.includes(cwd))
      throw new Error("Choose a working directory from the selected project");
    if (!projectId && !tasks.some((t) => t.cwd === cwd))
      throw new Error(
        "Choose a project or checkout already observed on this machine",
      );
    return this.command(
      id,
      "",
      "create",
      { hostId, projectId, cwd, title, prompt, isolate },
      async () => {
        await h.rpc.ensureControlAvailable();
        const worktree = isolate ? await h.worktree(cwd, title) : null,
          runCwd = worktree?.cwd || cwd;
        const params: any = {
          cwd: runCwd,
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
        };
        if (projectId) params.projectId = projectId;
        const r = await h.rpc.call("thread/start", params);
        const tid = r.thread.id,
          key = taskKey(hostId, tid);
        this.store.upsert({
          key,
          id: tid,
          hostId,
          title,
          cwd: runCwd,
          ...(projectId ? { projectId } : {}),
          ...(worktree?.branch ? { branch: worktree.branch } : {}),
          observedAt: Date.now(),
          updatedAt: Date.now(),
          status: "idle",
          owned: true,
          messages: [],
        });
        this.store.manage(key);
        await h.rpc.call("thread/name/set", { threadId: tid, name: title });
        const turn = await h.rpc.call("turn/start", {
          threadId: tid,
          input: [{ type: "text", text: prompt }],
        });
        this.emit("change");
        return { key, threadId: tid, turnId: turn.turn.id, worktree };
      },
    );
  }
  async pause(id: string, key: string) {
    const t = this.task(key),
      h = this.host(t.hostId);
    if (!t.managed)
      throw new Error("Open this desktop-owned task in Codex to pause it");
    return this.command(id, key, "pause", {}, async () => {
      const r = await h.rpc.call("thread/read", {
        threadId: t.id,
        includeTurns: true,
      });
      const active = r.thread?.turns?.findLast(
        (x: any) => x.status === "inProgress",
      );
      if (!active) throw new Error("No active turn to pause");
      return h.rpc.call("turn/interrupt", {
        threadId: t.id,
        turnId: active.id,
      });
    });
  }
  async archive(id: string, key: string) {
    const t = this.task(key),
      h = this.host(t.hostId);
    return this.command(id, key, "archive", {}, async () => {
      const approval = this.store.pendingApprovalForTask(key);
      if (approval)
        throw new Error(
          "Resolve the pending approval before archiving this task",
        );
      const current = await h.rpc.call("thread/read", {
          threadId: t.id,
          includeTurns: true,
        }),
        active = current.thread?.turns?.findLast(
          (turn: any) => turn.status === "inProgress",
        );
      if (active)
        throw new Error("Interrupt the active turn before archiving this task");
      await h.rpc.call("thread/archive", { threadId: t.id });
      this.store.removeTask(key);
      return { key, threadId: t.id, archived: true };
    });
  }
  async executeCoordinatorActions(plan: CoordinatorPlan) {
    const evidenceRevision =
      plan.evidenceRevision ||
      createHash("sha256")
        .update(JSON.stringify({ answer: plan.answer, actions: plan.actions }))
        .digest("hex");
    plan.evidenceRevision = evidenceRevision;
    this.store.staleCoordinatorProposalsExcept(evidenceRevision);
    const openActions = this.store.openActions(),
      feedback = this.store.briefingFeedback();
    return plan.actions.map((candidate, index): CoordinatorExecution => {
      const work = candidate.taskKey
          ? this.store.workItem(candidate.taskKey)
          : undefined,
        taskEvidenceRevision = work
          ? buildTaskBriefing(
              this.withAvailability(work),
              openActions,
              [],
              feedback,
            ).evidenceRevision
          : undefined,
        evidenceBoundCandidate = taskEvidenceRevision
          ? { ...candidate, briefingEvidenceRevision: taskEvidenceRevision }
          : candidate,
        modelActionId = candidate.id,
        proposalId = `proposal-${createHash("sha256")
          .update(`${evidenceRevision}\0${modelActionId}`)
          .digest("hex")}`,
        saved = this.store.saveCoordinatorProposal(
          proposalId,
          evidenceRevision,
          modelActionId,
          evidenceBoundCandidate,
        ),
        action = { ...saved.action, id: saved.id };
      plan.actions[index] = action;
      const actionClass = policyAction(action.type, action.decision),
        decision = actionClass
          ? policyDecision("coordinator", actionClass)
          : "deny";
      return {
        actionId: action.id,
        type: action.type,
        reason: action.reason,
        status: decision === "propose" ? "proposed" : "failed",
        summary:
          decision === "propose"
            ? "Proposal only — no workspace action was executed."
            : "Policy denied this coordinator recommendation.",
        taskKey: action.taskKey,
      };
    });
  }
  async chat(message: string) {
    if (this.chatBusy)
      throw new Error("The coordinator is answering your previous message");
    this.chatBusy = true;
    this.store.addChat("user", { answer: message });
    this.emit("change");
    try {
      const local = this.hosts.find((host) => !host.config.ssh);
      if (!local) throw new Error("A local Codex runtime is required");
      const tasks = this.store
        .tasks()
        .filter((task) => this.store.workItem(task.key));
      const snapshot = {
          tasks,
          projects: this.projects(),
          hosts: this.config.hosts,
          history: this.store.chat(),
          inboxActions: this.store.actions(),
        },
        evidenceRevision = createHash("sha256")
          .update(
            JSON.stringify({
              message,
              tasks: [...snapshot.tasks].sort((a, b) =>
                a.key.localeCompare(b.key),
              ),
              projects: [...snapshot.projects].sort((a, b) =>
                `${a.hostId}:${a.id}`.localeCompare(`${b.hostId}:${b.id}`),
              ),
              hosts: [...snapshot.hosts].sort((a, b) =>
                a.id.localeCompare(b.id),
              ),
              history: snapshot.history.slice(-10),
              inboxActions: [...snapshot.inboxActions].sort((a, b) =>
                String(a.id).localeCompare(String(b.id)),
              ),
            }),
          )
          .digest("hex"),
        result = await coordinate(
          local.config.codex,
          this.root,
          message,
          snapshot,
          this.config.coordinator,
        );
      result.evidenceRevision = evidenceRevision;
      result.executions = await this.executeCoordinatorActions(result);
      this.store.addChat("assistant", result);
      return result;
    } catch (error) {
      this.store.addChat("assistant", {
        answer: `Coordinator unavailable: ${(error as Error).message}`,
        actions: [],
        executions: [],
      });
      throw error;
    } finally {
      this.chatBusy = false;
      this.emit("change");
    }
  }
  event(h: Host, e: any, generation: string) {
    const p = e.params || {},
      tid = p.threadId || p.thread?.id;
    const key = tid ? taskKey(h.config.id, tid) : null;
    if (e.method === "project/changed") {
      void h.refreshProjects(true).finally(() => this.emit("change"));
      return;
    }
    if (
      (e.method === "thread/archived" || e.method === "thread/deleted") &&
      key
    ) {
      this.store.removeTask(key);
      this.emit("change");
      return;
    }
    if (e.id != null && e.method) {
      const supported = [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
        "item/tool/requestUserInput",
        "mcpServer/elicitation/request",
      ];
      if (!supported.includes(e.method)) {
        try {
          h.rpc.write({
            id: e.id,
            error: {
              code: -32601,
              message:
                "ThreadHelm does not support this interactive request. Open the task in Codex.",
            },
          });
        } catch {}
        return;
      }
      this.store.action(
        "approval",
        e.method.includes("requestUserInput")
          ? "Agent has a question"
          : e.method.includes("fileChange")
            ? "Review file access"
            : e.method.includes("commandExecution")
              ? "Review command"
              : "Permission or input needed",
        p.reason || p.command || p.message || "Review the request below.",
        key,
        `approval:${h.config.id}:${generation}:${JSON.stringify(e.id)}`,
        {
          hostId: h.config.id,
          generation,
          requestId: e.id,
          method: e.method,
          params: p,
        },
      );
      this.emit("change");
      return;
    }
    if (e.method === "serverRequest/resolved") {
      for (const a of this.store.pendingApprovals())
        if (
          a.kind === "approval" &&
          a.payload?.hostId === h.config.id &&
          JSON.stringify(a.payload.requestId) === JSON.stringify(p.requestId) &&
          a.payload.generation === generation
        )
          this.store.resolve(a.id);
    }
    if (e.method === "turn/completed" && key) {
      const turn = p.turn || {};
      this.store.action(
        turn.status === "failed" ? "failure" : "completion",
        turn.status === "failed"
          ? "Task needs attention"
          : "Agent finished a turn",
        turn.error?.message || "Review the latest response and changes.",
        key,
        `${turn.status === "failed" ? "failure" : "completion"}:${key}:${turn.id}${turn.status === "failed" ? ":failed" : ""}`,
      );
      void this.refreshHost(h);
    }
    if (e.method === "thread/project/updated") void this.refreshHost(h);
    if (
      [
        "turn/started",
        "turn/completed",
        "thread/status/changed",
        "thread/project/updated",
        "serverRequest/resolved",
      ].includes(e.method)
    )
      this.emit("change");
  }
  approval(id: string, decision: any) {
    const a = this.store.actionById(id);
    if (!a || a.kind !== "approval" || a.status !== "open")
      throw new Error("This request is no longer pending");
    const p = a.payload,
      h = this.host(p.hostId);
    let response: any;
    if (
      p.method === "item/commandExecution/requestApproval" ||
      p.method === "item/fileChange/requestApproval"
    ) {
      if (!["accept", "decline", "cancel"].includes(decision.action))
        throw new Error("Invalid decision");
      const offered = p.params.availableDecisions;
      if (Array.isArray(offered) && !offered.includes(decision.action))
        throw new Error("This decision is not available for the request");
      response = { decision: decision.action };
    } else if (p.method === "item/tool/requestUserInput") {
      const questions = p.params.questions || [];
      const answers: any = {};
      for (const q of questions) {
        const value = decision.answers?.[q.id];
        if (typeof value !== "string" || !value.trim())
          throw new Error("Answer every question");
        answers[q.id] = { answers: [value] };
      }
      response = { answers };
    } else if (p.method === "item/permissions/requestApproval") {
      if (!["accept", "decline"].includes(decision.action))
        throw new Error("Invalid decision");
      response = {
        permissions: decision.action === "accept" ? p.params.permissions : {},
        scope: "turn",
      };
    } else {
      if (decision.action !== "decline" && decision.action !== "cancel")
        throw new Error(
          "This connector request must be completed in Codex; it can only be declined here",
        );
      response = { action: decision.action, content: null };
    }
    h.rpc.respond(p.requestId, response, p.generation);
    this.store.resolve(id, "responding");
    this.emit("change");
    return { status: "responding" };
  }
  async decideExpiredApproval(
    id: string,
    approvalId: string,
    decision: "accept" | "decline",
  ) {
    const approval = this.store.actionById(approvalId);
    if (
      !approval ||
      approval.kind !== "approval" ||
      approval.status !== "expired"
    )
      throw new Error("Only an expired approval can be decided here");
    if (!["accept", "decline"].includes(decision))
      throw new Error("Choose whether to approve or decline this request");
    if (decision === "decline") {
      this.store.resolve(approval.id, "declined");
      this.emit("change");
      return { status: "declined" };
    }
    if (!approval.task_key)
      throw new Error("The original task is no longer available");
    const task = this.task(approval.task_key);
    if (!task.managed)
      throw new Error(
        "This task is not managed by ThreadHelm, so its agent must be reopened in Codex to request a new decision.",
      );
    const sent = await this.send(
      id,
      approval.task_key,
      "The owner has explicitly approved the previous request. Continue only with the exact scope you asked the owner to approve. Do not broaden it or infer permission for any other operation. If anything beyond that scope is needed, request a new approval.",
    );
    this.store.resolve(approval.id, "approved");
    this.emit("change");
    return sent;
  }
  close() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.shadowTimer) clearInterval(this.shadowTimer);
    for (const h of this.hosts) h.rpc.close();
    for (const adapter of this.adapters) adapter.close();
  }
}
