import { createHash } from "node:crypto";
import type {
  BriefingEntry,
  BriefingFeedbackRating,
  TaskBriefing,
  WorkItem,
  WorkspaceBriefing,
} from "./types.js";

interface InboxAction {
  id: string;
  task_key?: string | null;
  kind: string;
  title: string;
  body: string;
  status: string;
  created_at: number;
  updated_at: number;
}
interface CoordinatorProposal {
  id: string;
  evidence_revision: string;
  status: string;
  created_at: number;
  updated_at: number;
  action: {
    type?: string;
    reason?: string;
    taskKey?: string;
    briefingEvidenceRevision?: string;
  } | null;
}
interface BriefingFeedback {
  recommendation_id: string;
  evidence_revision: string;
  rating: BriefingFeedbackRating;
}
interface ShadowAnalysis {
  id: string;
  task_key: string;
  evidence_revision: string;
  route: string;
  model: string;
  status: string;
  category?: string | null;
  title?: string | null;
  recommendation?: string | null;
  rationale?: string | null;
  risk?: string | null;
  confidence?: string | null;
  next_checkpoint?: string | null;
  created_at: number;
  updated_at: number;
}

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clean = (value: unknown, max = 320) => {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const feedbackFor = (
  feedback: BriefingFeedback[],
  id: string,
  revision: string,
) =>
  feedback.find(
    (entry) =>
      entry.recommendation_id === id && entry.evidence_revision === revision,
  )?.rating;
const actionPriority = (action: InboxAction) =>
  action.kind === "approval"
    ? 100
    : action.kind === "blocked"
      ? 88
      : action.kind === "failure"
        ? 84
        : action.kind === "delivery"
          ? 80
          : action.kind === "review"
            ? 56
            : action.kind === "completion"
              ? 48
              : 20;
const openAction = (action: InboxAction) => action.status !== "resolved";
const evidence = (item: WorkItem, actions: InboxAction[]) => ({
  taskKey: item.key,
  status: item.status,
  statusConfidence: item.statusConfidence,
  updatedAt: item.updatedAt,
  watched: item.watched,
  latestExcerpt: clean(item.latestExcerpt || item.latest?.text, 1000),
  error: clean(item.error, 1000),
  execution: {
    host: item.execution?.host || item.hostId,
    provider: item.execution?.provider,
    requestedModel: item.execution?.requestedModel,
    resolvedModel: item.execution?.resolvedModel,
    locality: item.execution?.locality,
  },
  sources: (item.sourceRefs || [])
    .map((source) => ({
      adapter: source.adapter,
      sourceId: source.sourceId,
      nativeId: source.nativeId,
    }))
    .sort((a, b) =>
      `${a.adapter}:${a.sourceId}:${a.nativeId}`.localeCompare(
        `${b.adapter}:${b.sourceId}:${b.nativeId}`,
      ),
    ),
  actions: actions
    .filter(openAction)
    .map((action) => ({
      id: action.id,
      kind: action.kind,
      title: clean(action.title, 500),
      body: clean(action.body, 1000),
      status: action.status,
      createdAt: action.created_at,
      updatedAt: action.updated_at,
    }))
    .sort((a, b) => a.id.localeCompare(b.id)),
});
const evidenceLines = (item: WorkItem, actions: InboxAction[]) => {
  const lines = [
    `${item.statusConfidence === "authoritative" ? "Authoritative" : "Heuristic"} status: ${item.status}`,
    `Last source update: ${new Date(item.updatedAt).toISOString()}`,
  ];
  if (item.execution?.provider)
    lines.push(`Provider: ${item.execution.provider}`);
  if (item.execution?.requestedModel)
    lines.push(`Model: ${item.execution.requestedModel}`);
  if (actions[0]) lines.push(`Open ${actions[0].kind}: ${clean(actions[0].title)}`);
  return lines;
};
const currentCopy = (item: WorkItem) => {
  const excerpt = clean(item.error || item.latestExcerpt || item.latest?.text, 240),
    host = clean(item.execution?.host || item.hostId, 80);
  if (item.status === "active")
    return {
      title: item.statusConfidence === "authoritative" ? "Running now" : "Activity reported",
      body: excerpt || `Active work is reported on ${host}.`,
      priority: item.watched ? 74 : 66,
    };
  if (item.status === "recent")
    return {
      title: "Recently active",
      body: excerpt || `Recent activity was reported on ${host}; live execution is not proven.`,
      priority: item.watched ? 64 : 54,
    };
  if (item.status === "waiting")
    return {
      title: "Waiting",
      body: excerpt || "The source reports that this work is waiting for attention.",
      priority: 82,
    };
  if (item.status === "failed")
    return {
      title: "Failed",
      body: excerpt || "The source reports a failure that needs inspection.",
      priority: 92,
    };
  if (item.status === "completed")
    return {
      title: "Completed",
      body: excerpt || "The source reports that this work completed.",
      priority: item.watched ? 48 : 24,
    };
  if (item.status === "offline")
    return {
      title: "Source unavailable",
      body: excerpt || "The last known state is retained, but the source is unavailable.",
      priority: 78,
    };
  return {
    title: item.status === "idle" ? "Idle" : "State uncertain",
    body: excerpt || "No current operation is reported.",
    priority: item.watched ? 36 : 16,
  };
};
const nextCopy = (item: WorkItem, action?: InboxAction) => {
  if (action?.kind === "approval")
    return {
      title: "Waiting for your decision",
      body: "The task is paused until you choose an offered response. Afterward, watch for its next update.",
      priority: 98,
    };
  if (action?.kind === "blocked")
    return {
      title: "Waiting for the missing input",
      body: "The task cannot continue until the input requested above is available. After that, watch for its next update.",
      priority: 86,
    };
  if (item.status === "failed")
    return {
      title: "Waiting for failure review",
      body: "No safe retry is expected until the failure and current source state have been reviewed.",
      priority: 90,
    };
  if (item.status === "waiting")
    return {
      title: "Waiting for input",
      body: "The source reports that progress is paused. Its next checkpoint is an update after the missing input arrives.",
      priority: 82,
    };
  if (item.status === "active" || item.status === "recent")
    return {
      title: "Wait for the next checkpoint",
      body: item.watched
        ? "Astra will keep this work visible when its state changes."
        : "Open the work for evidence, or watch it if the outcome matters.",
      priority: item.watched ? 66 : 52,
    };
  if (item.status === "completed")
    return {
      title: "Result ready for review",
      body: "The reported result is available. Check its evidence before deciding what follows.",
      priority: item.watched ? 58 : 34,
    };
  if (item.status === "offline")
    return {
      title: "Restore evidence first",
      body: "Reconnect or refresh the source before relying on the retained state.",
      priority: 76,
    };
  return {
    title: "No immediate step",
    body: "Continue only when this work supports a current objective.",
    priority: item.watched ? 30 : 10,
  };
};
const deterministicRecommendation = (
  item: WorkItem,
  action: InboxAction | undefined,
  revision: string,
  lines: string[],
): BriefingEntry => {
  let rule = "keep",
    title = "Keep available",
    body = "No urgent change is supported by the current evidence.",
    priority = item.watched ? 38 : 18;
  if (action?.kind === "approval") {
    rule = "await-owner-decision";
    title = "No recommendation until you decide";
    body = "This choice belongs to you. Astra does not recommend an outcome from the current evidence.";
    priority = 30;
  } else if (action?.kind === "blocked" || item.status === "waiting") {
    rule = "await-missing-input";
    title = "No additional recommendation";
    body = "The work needs the requested input before Astra can recommend a safe change.";
    priority = 30;
  } else if (item.status === "failed" || action?.kind === "failure") {
    rule = "inspect-failure";
    title = "Inspect the failure before retrying";
    body = clean(item.error || action?.body || item.latestExcerpt, 300) || "The source reports a failure.";
    priority = 92;
  } else if (item.status === "offline") {
    rule = "refresh-source";
    title = "Refresh the source before acting";
    body = "The retained state may be stale, so recommendations that change work would be unsafe.";
    priority = 78;
  } else if (item.status === "completed" && item.watched) {
    rule = "review-result";
    title = "Review the completed result";
    body = "This watched work reached a review checkpoint; confirm its evidence and decide what follows.";
    priority = 60;
  } else if ((item.status === "active" || item.status === "recent") && !item.watched) {
    rule = "consider-watch";
    title = "Decide whether this outcome matters";
    body = "This work is active but not watched. Keep it visible only if you need its result or a future decision.";
    priority = 52;
  }
  const id = `recommendation-${digest({ taskKey: item.key, revision, rule })}`;
  return {
    id,
    kind: "recommendation",
    taskKey: item.key,
    workTitle: item.title,
    actionId: action?.id,
    title,
    body,
    evidenceRevision: revision,
    evidence: lines,
    source: "deterministic",
    isAdvice: !["await-owner-decision", "await-missing-input"].includes(rule),
    confidence: item.statusConfidence,
    updatedAt: Math.max(item.updatedAt, action?.updated_at || 0),
    priority,
  };
};
const proposalRecommendation = (
  proposal: CoordinatorProposal,
  item: WorkItem | undefined,
): BriefingEntry => {
  const type = clean(proposal.action?.type || "recommendation", 80),
    taskKey = proposal.action?.taskKey;
  return {
    id: proposal.id,
    kind: "recommendation",
    ...(taskKey ? { taskKey } : {}),
    ...(item ? { workTitle: item.title } : {}),
    title: `Astra recommends: ${type}`,
    body: clean(proposal.action?.reason, 500) || "Review this proposal and its evidence.",
    evidenceRevision: proposal.evidence_revision,
    evidence: [
      "Model recommendation; proposal only",
      `Evidence revision: ${proposal.evidence_revision}`,
      ...(item ? [`Task status when last observed: ${item.status}`] : []),
    ],
    source: "model",
    analysisMode: "coordinator",
    isAdvice: true,
    confidence: item?.statusConfidence || "heuristic",
    updatedAt: proposal.updated_at || proposal.created_at,
    priority: item ? 86 : 70,
  };
};
const shadowRecommendation = (
  analysis: ShadowAnalysis,
  item: WorkItem,
  action?: InboxAction,
): BriefingEntry => ({
  id: analysis.id,
  kind: "recommendation",
  taskKey: item.key,
  workTitle: item.title,
  ...(action && analysis.category === "resolve-decision" ? { actionId: action.id } : {}),
  title: clean(analysis.title, 240) || "AI shadow recommendation",
  body:
    clean(analysis.recommendation, 700) ||
    "Review the shadow analysis and current evidence.",
  evidenceRevision: analysis.evidence_revision,
  evidence: [
    "AI shadow analysis; no action executed",
    `Category: ${clean(analysis.category || "review", 80)}`,
    `Confidence: ${clean(analysis.confidence || "low", 40)}`,
    `Model: ${clean(analysis.model, 120)}`,
    `Risk: ${clean(analysis.risk || "Not reported", 500)}`,
    `Rationale: ${clean(analysis.rationale || "Not reported", 700)}`,
    `Next checkpoint: ${clean(analysis.next_checkpoint || "Review current evidence", 500)}`,
  ],
  source: "model",
  analysisMode: "shadow",
  isAdvice: true,
  confidence: item.statusConfidence,
  updatedAt: analysis.updated_at || analysis.created_at,
  priority: ["failed", "waiting"].includes(item.status) ? 94 : 76,
});

export function buildTaskBriefing(
  item: WorkItem,
  actions: InboxAction[] = [],
  proposals: CoordinatorProposal[] = [],
  feedback: BriefingFeedback[] = [],
  analyses: ShadowAnalysis[] = [],
): TaskBriefing {
  const relevant = actions
      .filter((action) => openAction(action) && action.task_key === item.key)
      .sort(
        (a, b) =>
          actionPriority(b) - actionPriority(a) || b.created_at - a.created_at,
      ),
    revision = digest(evidence(item, relevant)),
    lines = evidenceLines(item, relevant),
    current = currentCopy(item),
    decisionAction = relevant.find((action) =>
      ["approval", "blocked"].includes(action.kind),
    ),
    next = nextCopy(item, decisionAction),
    shadow = analyses
      .filter(
        (analysis) =>
          analysis.status === "succeeded" &&
          analysis.task_key === item.key &&
          analysis.evidence_revision === revision,
      )
      .sort((a, b) => b.created_at - a.created_at)[0],
    model = proposals
      .filter(
        (proposal) =>
          proposal.status === "proposed" &&
          proposal.action?.taskKey === item.key &&
          proposal.action.briefingEvidenceRevision === revision,
      )
      .sort((a, b) => b.created_at - a.created_at)[0],
    recommendation = shadow
      ? shadowRecommendation(shadow, item, decisionAction)
      : model
        ? proposalRecommendation(model, item)
        : deterministicRecommendation(item, relevant[0], revision, lines);
  recommendation.feedback = feedbackFor(
    feedback,
    recommendation.id,
    recommendation.evidenceRevision,
  );
  return {
    taskKey: item.key,
    evidenceRevision: revision,
    current: {
      id: `current-${digest({ taskKey: item.key, revision })}`,
      kind: "current",
      taskKey: item.key,
      workTitle: item.title,
      title: current.title,
      body: current.body,
      evidenceRevision: revision,
      evidence: lines,
      source: "deterministic",
      confidence: item.statusConfidence,
      updatedAt: item.updatedAt,
      priority: current.priority,
    },
    ...(decisionAction
      ? {
          decision: {
            id: `decision-${decisionAction.id}`,
            kind: "decision" as const,
            taskKey: item.key,
            workTitle: item.title,
            actionId: decisionAction.id,
            title: clean(decisionAction.title, 240) || "Decision needed",
            body: clean(decisionAction.body, 500) || "Review the open request.",
            evidenceRevision: revision,
            evidence: lines,
            source: "deterministic" as const,
            confidence: item.statusConfidence,
            updatedAt: decisionAction.updated_at,
            priority: actionPriority(decisionAction),
          },
        }
      : {}),
    recommendation,
    next: {
      id: `next-${digest({ taskKey: item.key, revision, title: next.title })}`,
      kind: "next",
      taskKey: item.key,
      workTitle: item.title,
      actionId: decisionAction?.id,
      title: next.title,
      body: next.body,
      evidenceRevision: revision,
      evidence: lines,
      source: "deterministic",
      confidence: item.statusConfidence,
      updatedAt: Math.max(item.updatedAt, decisionAction?.updated_at || 0),
      priority: next.priority,
    },
    attentionScore: Math.max(
      current.priority,
      decisionAction ? actionPriority(decisionAction) : 0,
      recommendation.priority,
      next.priority,
    ),
  };
}

const section = (items: BriefingEntry[], limit = 12) => ({
  total: items.length,
  items: items
    .sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt)
    .slice(0, limit),
});

export function buildWorkspaceBriefing(
  items: WorkItem[],
  actions: InboxAction[] = [],
  proposals: CoordinatorProposal[] = [],
  feedback: BriefingFeedback[] = [],
  now = Date.now(),
  analyses: ShadowAnalysis[] = [],
): WorkspaceBriefing {
  const unique = [...new Map(items.map((item) => [item.key, item])).values()],
    taskMap = new Map(unique.map((item) => [item.key, item])),
    briefs = unique.map((item) =>
      buildTaskBriefing(item, actions, proposals, feedback, analyses),
    ),
    taskProposalIds = new Set(
      briefs
        .filter((brief) => brief.recommendation.source === "model")
        .map((brief) => brief.recommendation.id),
    ),
    globalProposals = proposals
      .filter(
        (proposal) =>
          proposal.status === "proposed" &&
          !proposal.action?.taskKey &&
          !taskProposalIds.has(proposal.id),
      )
      .map((proposal) => {
        const entry = proposalRecommendation(
          proposal,
          proposal.action?.taskKey
            ? taskMap.get(proposal.action.taskKey)
            : undefined,
        );
        entry.feedback = feedbackFor(
          feedback,
          entry.id,
          entry.evidenceRevision,
        );
        return entry;
      }),
    nowRunning = briefs
      .filter((brief) => {
        const item = taskMap.get(brief.taskKey);
        return item && ["active", "recent"].includes(item.status);
      })
      .map((brief) => brief.current),
    decisions = briefs.flatMap((brief) =>
      brief.decision ? [brief.decision] : [],
    ),
    recommendations = [
      ...briefs
        .filter(
          (brief) =>
            brief.recommendation.source === "model" &&
            brief.recommendation.isAdvice !== false,
        )
        .map((brief) => brief.recommendation),
      ...globalProposals,
    ],
    nextSteps = briefs
      .filter((brief) => brief.attentionScore >= 48)
      .map((brief) => brief.next),
    workspaceRevision = digest({
      tasks: briefs
        .map((brief) => ({
          taskKey: brief.taskKey,
          evidenceRevision: brief.evidenceRevision,
        }))
        .sort((a, b) => a.taskKey.localeCompare(b.taskKey)),
      proposals: proposals
        .filter((proposal) => proposal.status === "proposed")
        .map((proposal) => ({
          id: proposal.id,
          revision: proposal.evidence_revision,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      analyses: analyses
        .filter((analysis) => analysis.status === "succeeded")
        .map((analysis) => ({
          id: analysis.id,
          revision: analysis.evidence_revision,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
  return {
    generatedAt: now,
    evidenceRevision: workspaceRevision,
    nowRunning: section(nowRunning),
    decisions: section(decisions),
    recommendations: section(recommendations),
    nextSteps: section(nextSteps),
  };
}
