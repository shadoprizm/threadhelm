import {
  checkoutAssessment,
  filterInboxGroups,
  groupInboxActions,
  projectsForHost,
  uiStateFingerprint,
  workContext,
  workspaceTasks,
} from "./workspace.js";
import {
  compactConversation,
  conversationSignal,
  plainPreview,
  renderRichText,
  reviewSummary,
  scrollTopAfterRender,
} from "./conversation.js";

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let state = {
    tasks: [],
    projects: [],
    hosts: [],
    sources: [],
    actions: [],
    commands: [],
    chat: [],
    briefing: {},
    shadowAnalysis: {},
    runtime: {},
  },
  filter = "all",
  view = "overview",
  panel = null,
  detail = null,
  busy = false,
  csrf = "",
  search = "",
  sourceFilter = "",
  hostFilter = "",
  kindFilter = "",
  statusFilter = "",
  providerFilter = "",
  localityFilter = "",
  modelFilter = "",
  nextWorkCursor = null,
  stream,
  createProjects = [],
  allCreateProjects = [],
  inboxFilter = "all",
  inboxSearch = "",
  inboxSort = "newest",
  inboxLimit = 24,
  inboxGroups = new Map();
const drafts = new Map();
const selectedActions = new Set();
const expandedBriefingEvidence = new Set();
let workFilterTimer,
  renderedPageRevision = "";
const ago = (t) => {
  if (!t) return "Not yet seen";
  const d = Math.max(0, (Date.now() - t) / 1000);
  return d < 60
    ? "just now"
    : d < 3600
      ? `${Math.floor(d / 60)}m ago`
      : d < 86400
        ? `${Math.floor(d / 3600)}h ago`
        : `${Math.floor(d / 86400)}d ago`;
};
const hostName = (id) => state.hosts.find((h) => h.id === id)?.name || id;
const stale = (t) => {
  if (t.status === "offline" || Date.now() - t.observedAt > 45000) return true;
  const refs = t.sourceRefs || [];
  if (
    refs.some(
      (ref) =>
        ref.adapter === "codex" &&
        state.hosts.find((h) => h.id === ref.hostId)?.online,
    )
  )
    return false;
  if (
    refs.some(
      (ref) =>
        ref.adapter !== "codex" &&
        !state.sources.find((source) => source.id === ref.sourceId)?.stale,
    )
  )
    return false;
  return refs.length
    ? true
    : !state.hosts.find((h) => h.id === t.hostId)?.online;
};
const taskStatus = (t) =>
  state.demo?.enabled ? t.status : stale(t) ? "offline" : t.status;
const repo = (t) => {
  if (!t?.cwd)
    return (
      t?.sourceRefs?.[0]?.profile ||
      t?.sourceRefs?.[0]?.agent ||
      t?.kind ||
      "Conversation"
    );
  const p = t.cwd.split("/");
  return p.at(-1) === "project" ? p.at(-2) : p.at(-1);
};
const contextFor = (t) => workContext(t, state.projects || []);
const contextSummary = (t) => {
  const context = contextFor(t),
    project = context.projectName
      ? `Project: ${context.projectName}`
      : "Project: Not linked",
    repository = context.repository
      ? `Repository: ${context.repository}`
      : "Repository: Not available";
  return `${context.kind} · ${project} · ${repository}`;
};
const contextHtml = (t, className = "") => {
  const context = contextFor(t),
    project = context.projectName || "Not linked",
    repository = context.repository || "Not available";
  return `<div class="work-context ${className}" aria-label="${esc(contextSummary(t))}"><span class="work-context-kind">${esc(context.kind)}</span><span><b>Project</b> ${esc(project)}</span><span${context.repositoryPath ? ` title="${esc(context.repositoryPath)}"` : ""}><b>Repository</b> ${esc(repository)}</span></div>`;
};
const sourceName = (t) => {
  const names = {
    codex: "Codex",
    claude: "Claude Code",
    hermes: "Hermes",
    openclaw: "OpenClaw",
    openwebui: "Open WebUI",
  };
  const refs = t?.sourceRefs || [];
  return refs.length > 1
    ? `${names[refs[0].adapter] || refs[0].adapter} +${refs.length - 1}`
    : names[refs[0]?.adapter] || "Unknown";
};
const approvalSubject = (payload) => {
  switch (payload?.method) {
    case "item/permissions/requestApproval":
      return "access";
    case "item/commandExecution/requestApproval":
      return "command";
    case "item/fileChange/requestApproval":
      return "file change";
    default:
      return "request";
  }
};
const approvalContextHtml = (payload) => {
  const subject = approvalSubject(payload);
  return `<section class="approval-context"><div class="eyebrow">NO ASTRA RECOMMENDATION ATTACHED</div><strong>This is an authorization request, not advice.</strong><p>You are deciding only whether the agent may make the exact ${esc(subject)} shown below. If it later needs broader access or another action, it must request a new approval.</p></section>`;
};
const title = (t) => t?.title || "Task";
const shortTitle = (t) =>
  title(t).length > 180 ? title(t).slice(0, 177) + "…" : title(t);
const activeActions = () =>
  state.actions.filter((a) => a.status !== "resolved");
function toast(text, error = false) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  t.classList.toggle("error", error);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), error ? 10000 : 4500);
}
async function api(path, body) {
  if (body?.requestId) {
    const key =
      "threadhelm-request:" +
      path +
      JSON.stringify({ ...body, requestId: undefined });
    const existing = sessionStorage.getItem(key);
    if (existing) body.requestId = existing;
    else sessionStorage.setItem(key, body.requestId);
    body.__storageKey = key;
  }
  const storageKey = body?.__storageKey;
  if (body) delete body.__storageKey;
  const r = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body
      ? { "Content-Type": "application/json", "X-ThreadHelm": csrf }
      : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const contentType = r.headers.get("content-type") || "";
  const responseText = await r.text();
  let d;
  if (!/\bapplication\/json\b/i.test(contentType)) {
    if (r.redirected || /^\s*</.test(responseText))
      throw new Error(
        "Your secure dashboard session expired. Reload this page and sign in again, then retry the action.",
      );
    throw new Error(
      "The dashboard returned an unexpected response. Reload the page and try again.",
    );
  }
  try {
    d = JSON.parse(responseText || "{}");
  } catch {
    throw new Error(
      "The dashboard returned invalid data. Reload the page and try again.",
    );
  }
  if (!r.ok) {
    if (storageKey && d.error && !/timed out|connection closed/i.test(d.error))
      sessionStorage.removeItem(storageKey);
    throw new Error(d.error || "Request failed");
  }
  if (d.status && ["failed", "uncertain", "sending"].includes(d.status))
    throw new Error(
      d.result?.error ||
        "Delivery is " + d.status + ". Check Activity before trying again.",
    );
  if (storageKey) sessionStorage.removeItem(storageKey);
  return d;
}
function workQuery(cursor = "") {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor) query.set("cursor", cursor);
  if (sourceFilter) query.set("source", sourceFilter);
  if (hostFilter) query.set("host", hostFilter);
  if (kindFilter) query.set("kind", kindFilter);
  if (statusFilter) query.set("status", statusFilter);
  if (providerFilter) query.set("provider", providerFilter);
  if (localityFilter) query.set("locality", localityFilter);
  if (modelFilter) query.set("model", modelFilter);
  if (search) query.set("search", search);
  if (filter === "watched") query.set("watched", "true");
  if (filter === "running" && !statusFilter) query.set("status", "active");
  return "/api/work-items?" + query;
}
async function loadWork(reset = true) {
  const page = await api(workQuery(reset ? "" : nextWorkCursor || ""));
  state.tasks = reset
    ? page.items
    : [
        ...state.tasks,
        ...page.items.filter(
          (item) => !state.tasks.some((existing) => existing.key === item.key),
        ),
      ];
  nextWorkCursor = page.nextCursor;
}
async function refreshMeta() {
  const tasks = state.tasks,
    summary = await api("/api/state");
  state = { ...summary, tasks };
  csrf = state.csrf;
}
function chatChanged(before, after) {
  return (
    before.length !== after.length || before.at(-1)?.id !== after.at(-1)?.id
  );
}
function pageRevision(value = state) {
  return uiStateFingerprint({
    view,
    version: value.version,
    build: value.build,
    demo: value.demo,
    summary: value.summary,
    hosts: value.hosts,
    sources: value.sources,
    tasks: value.tasks,
    inboxItems: value.inboxItems,
    actions: value.actions,
    briefing: value.briefing,
    ...(view === "activity" ? { commands: value.commands } : {}),
    ...(view === "runtime"
      ? { runtime: value.runtime, shadowAnalysis: value.shadowAnalysis }
      : {}),
  });
}
function renderIfChanged() {
  if (pageRevision() === renderedPageRevision) return false;
  render();
  return true;
}
function briefingFeedbackHtml(entry) {
  if (entry.kind !== "recommendation" || entry.source !== "model") return "";
  return `<div class="briefing-feedback" aria-label="Rate this recommendation"><span>Was this useful?</span>${[
    ["useful", "Useful"],
    ["wrong", "Wrong"],
    ["stale", "Stale"],
  ]
    .map(
      ([value, label]) =>
        `<button class="${entry.feedback === value ? "selected" : ""}" data-briefing-feedback="${value}" data-recommendation="${esc(entry.id)}" data-revision="${esc(entry.evidenceRevision)}"${entry.taskKey ? ` data-briefing-task="${esc(entry.taskKey)}"` : ""} aria-pressed="${entry.feedback === value}">${label}</button>`,
    )
    .join("")}</div>`;
}
function briefingEvidenceValue(entry, label) {
  const prefix = `${label}:`;
  const line = (entry.evidence || []).find((value) =>
    String(value).startsWith(prefix),
  );
  return line ? String(line).slice(prefix.length).trim() : "";
}
function briefingAction(entry) {
  const task = [...state.tasks, ...(state.inboxItems || [])].find(
      (item) => item.key === entry.taskKey,
    ),
    external = task?.sourceRefs?.find(
      (source) => source.adapter !== "codex" && source.deepLink,
    );
  if (entry.actionId && external)
    return {
      label: `Open ${sourceName(task)} to decide`,
      outcome: "This source owns the task, so its exact decision must be completed there.",
      href: external.deepLink,
    };
  if (entry.actionId)
    return {
      label:
        entry.kind === "next"
          ? "Make the required decision"
          : "Make this decision",
      outcome:
        entry.kind === "next"
          ? "Open the exact choice that is blocking this next step."
          : "Open the exact request and submit one of its available choices.",
      attributes: `data-action="${esc(entry.actionId)}"`,
    };
  if (entry.kind === "recommendation" && entry.source === "model") {
    if (external)
      return {
        label: `Open ${sourceName(task)} to act`,
        outcome: "This source owns the task, so its action must be completed there.",
        href: external.deepLink,
      };
    if (
      task?.sourceRefs?.some((source) => source.adapter === "codex") &&
      (task.controlAvailable === false || (task.owned && !task.managed))
    )
      return {
        label: "Open in Codex to run this",
        outcome: "Codex desktop owns this task, so the recommendation must run there.",
        href: `codex://threads/${encodeURIComponent(task.id)}`,
      };
    const category = briefingEvidenceValue(entry, "Category").toLowerCase(),
      actions = {
        continue: [
          "Continue safely",
          "Tell Astra to continue from its last safe checkpoint. It will ask again before any new approval is needed.",
        ],
        inspect: [
          "Ask Astra to inspect this",
          "Tell Astra to examine the interruption and report the safest next action without resuming implementation.",
        ],
        "resolve-decision": [
          "Ask Astra to identify the decision",
          "Tell Astra to return the one specific question it needs answered before continuing.",
        ],
        wait: [
          "Watch for an update",
          "Start monitoring this work and surface the next meaningful change here.",
        ],
        watch: [
          "Watch this work",
          "Start monitoring this work and surface the next meaningful change here.",
        ],
        keep: [
          "Keep watching",
          "Keep this work visible and surface the next meaningful change here.",
        ],
        "archive-candidate": [
          "Archive this task",
          "Archive this inactive task. It remains recoverable in Codex.",
        ],
        "move-model-candidate": [
          "Prepare a model-change plan",
          "Tell Astra to prepare the exact model-change plan without changing the task yet.",
        ],
      },
      [label, outcome] = actions[category] || [
        "Apply this recommendation",
        "Run Astra’s constrained next action for this recommendation.",
      ];
    return {
      label,
      outcome,
      attributes: `data-apply-recommendation="${esc(entry.id)}" data-revision="${esc(entry.evidenceRevision)}"${entry.taskKey ? ` data-briefing-task="${esc(entry.taskKey)}"` : ""}`,
    };
  }
  if (entry.kind === "current")
    return {
      label: "Check latest status",
      outcome: "Refresh the source and show whether this work is still moving.",
      attributes: "data-briefing-refresh",
    };
  if (entry.kind === "next" && entry.taskKey)
    return {
      label: "Watch for this update",
      outcome: "Keep this work visible and surface the next meaningful change here.",
      attributes: `data-briefing-watch="${esc(entry.taskKey)}"`,
    };
  return {
    label: "Check latest status",
    outcome: "Refresh the source before deciding what to do next.",
    attributes: "data-briefing-refresh",
  };
}
function briefingActionHtml(entry) {
  const action = briefingAction(entry);
  return `<div class="briefing-next-move"><span>CLICKING THIS WILL</span><p>${esc(action.outcome)}</p>${action.href ? `<a class="briefing-execute" href="${esc(action.href)}">${esc(action.label)} →</a>` : `<button class="briefing-execute" ${action.attributes}>${esc(action.label)} →</button>`}</div>`;
}
function briefingEntryHtml(entry) {
  const source =
      entry.analysisMode === "shadow"
        ? "Astra analysis"
        : entry.source === "model"
        ? "Astra proposal"
          : "System guidance",
    task = [...state.tasks, ...(state.inboxItems || [])].find(
      (item) => item.key === entry.taskKey,
    ),
    subject = entry.workTitle || task?.title || "Workspace",
    expanded = expandedBriefingEvidence.has(entry.id);
  const evidenceLabel = `Evidence ${entry.evidenceRevision.slice(0, 8)}`;
  return `<article class="briefing-item ${esc(entry.source)}"><div class="briefing-kicker"><span>${esc(source)}</span><span>${ago(entry.updatedAt)}</span></div><strong>${esc(subject)}</strong>${task ? contextHtml(task, "briefing-work-context") : ""}<h4>${esc(entry.title)}</h4><p>${esc(entry.body)}</p>${briefingActionHtml(entry)}<div class="briefing-item-actions"><button class="briefing-evidence" data-show-evidence="${esc(entry.id)}" data-evidence-label="${esc(evidenceLabel)}" aria-expanded="${expanded}" aria-label="${expanded ? "Hide" : "Show"} evidence for ${esc(entry.title)}">${expanded ? "Hide evidence" : esc(evidenceLabel)}</button></div>${briefingFeedbackHtml(entry)}<div class="briefing-evidence-lines" data-evidence-for="${esc(entry.id)}" ${expanded ? "" : "hidden"}>${(entry.evidence || []).map((line) => `<span>${esc(line)}</span>`).join("")}</div></article>`;
}
function briefingColumnHtml(section, empty) {
  return section?.items?.length
    ? section.items.slice(0, 4).map(briefingEntryHtml).join("")
    : `<div class="briefing-empty">${esc(empty)}</div>`;
}
function renderBriefing() {
  const briefing = state.briefing || {},
    name = state.supervisorName || "Astra";
  $("#briefing-title").textContent = `${name} briefing`;
  $("#briefing-revision").textContent = briefing.evidenceRevision
    ? `Evidence ${briefing.evidenceRevision.slice(0, 10)} · refreshed ${ago(briefing.generatedAt)}`
    : "No briefing evidence available";
  const shadow = state.shadowAnalysis || {};
  $("#briefing-shadow").textContent = shadow.enabled
    ? `Shadow ${shadow.status} · ${shadow.today?.calls || 0}/${shadow.limits?.dailyCalls || 20} calls today · ${shadow.pending || 0} queued`
    : "Shadow analysis is disabled.";
  const sections = [
    ["now", briefing.nowRunning, "No source currently proves that work is running."],
    ["decisions", briefing.decisions, "No open decision currently needs you."],
    ["recommendations", briefing.recommendations, "No recommendation is supported by current evidence."],
    ["next", briefing.nextSteps, "No immediate next step is supported by current evidence."],
  ];
  for (const [id, section, empty] of sections) {
    $(`#briefing-${id}`).innerHTML = briefingColumnHtml(section, empty);
    $(`#briefing-${id}-count`).textContent = `${section?.total || 0} item${section?.total === 1 ? "" : "s"}`;
  }
}
function taskBriefCardHtml(task) {
  const briefing = task.briefing;
  if (!briefing) return "";
  const recommendationLabel =
      briefing.recommendation?.source === "model" ? "Astra" : "Guidance",
    rows = [
      ["Now", briefing.current?.title],
      ["You", briefing.decision?.title || "No decision pending"],
      [recommendationLabel, briefing.recommendation?.title],
      ["Next", briefing.next?.title],
    ];
  return `<button class="task-brief" data-task="${esc(task.key)}" aria-label="Open evidence briefing for ${esc(shortTitle(task))}">${rows.map(([label, value]) => `<span><b>${label}</b><em>${esc(value || "Not available")}</em></span>`).join("")}</button>`;
}
function taskBriefDetailHtml(task) {
  const briefing = task.briefing;
  if (!briefing) return "";
  const entries = [
    ["Now", briefing.current],
    ["Your decision", briefing.decision],
    [
      briefing.recommendation?.source === "model"
        ? "Astra’s recommendation"
        : "System next step",
      briefing.recommendation,
    ],
    ["Next", briefing.next],
  ];
  return `<section class="task-brief-detail"><div class="task-brief-detail-heading"><div><div class="eyebrow">EVIDENCE BRIEF</div><h3>Choose or run the next move</h3></div><small>${esc(briefing.evidenceRevision.slice(0, 10))}</small></div><div class="task-brief-detail-grid">${entries.map(([label, entry]) => `<article class="${entry ? "" : "empty-entry"}"><span>${esc(label)}</span><strong>${esc(entry?.title || "Nothing pending")}</strong><p>${esc(entry?.body || "No owner decision is required by the current evidence.")}</p>${entry ? briefingActionHtml(entry) : ""}${label === "System next step" ? '<small class="briefing-origin">Status guidance, not an Astra-proposed solution.</small>' : ""}${entry?.kind === "recommendation" ? briefingFeedbackHtml(entry) : ""}</article>`).join("")}</div></section>`;
}
async function refresh() {
  try {
    const previous = state.tasks,
      previousHosts = state.hosts,
      previousChat = state.chat,
      previousChatBusy = state.chatBusy,
      [summary, page] = await Promise.all([
        api("/api/state"),
        api(workQuery()),
      ]);
    state = { ...summary, tasks: page.items };
    nextWorkCursor = page.nextCursor;
    csrf = state.csrf;
    const pageScroll = { x: window.scrollX, y: window.scrollY };
    if (renderIfChanged()) window.scrollTo(pageScroll.x, pageScroll.y);
    if (
      panel === "chat" &&
      (previousChatBusy !== state.chatBusy ||
        chatChanged(previousChat, state.chat))
    )
      renderChat();
    if (
      panel === "machines" &&
      uiStateFingerprint(previousHosts) !== uiStateFingerprint(state.hosts)
    )
      openMachines();
    if (
      detail &&
      panel === detail.task.key &&
      !$("#send-input")?.matches(":focus")
    ) {
      const current =
        state.tasks.find((t) => t.key === panel) ||
        previous.find((t) => t.key === panel);
      if (
        current &&
        (current.latest?.id !== detail.task.latest?.id ||
          current.status !== detail.task.status)
      )
        void openTask(panel);
    }
  } catch (e) {
    $("#connection").textContent = "Reconnecting";
    $("#connection").classList.add("stale");
  }
}
function render() {
  const { watched, running } = workspaceTasks(state.tasks, taskStatus),
    watchedTotal = state.summary?.watched ?? watched.length,
    runningTotal =
      (state.summary?.byStatus?.active || 0) +
      (state.summary?.byStatus?.recent || 0),
    attention = activeActions(),
    inboxTasks = [
      ...state.tasks,
      ...(state.inboxItems || []).filter(
        (item) => !state.tasks.some((task) => task.key === item.key),
      ),
    ],
    groups = groupInboxActions(attention, inboxTasks),
    connected = state.hosts.filter((h) => h.online).length,
    demo = !!state.demo?.enabled;
  $("#demo-banner").hidden = !demo;
  $("#new-task").hidden = demo;
  $("#open-coordinator").hidden = demo;
  $("#connection").textContent = demo
    ? "Sample data"
    : connected === state.hosts.length
      ? "Live updates"
      : `${state.hosts.length - connected} machine${state.hosts.length - connected === 1 ? "" : "s"} offline`;
  $("#connection").classList.toggle(
    "stale",
    !demo && connected !== state.hosts.length,
  );
  $("#machines").innerHTML = state.hosts
    .map(
      (h) =>
        `<button class="machine" data-host="${esc(h.id)}" title="${esc(h.error || "View machine details")}"><span class="machine-symbol">${h.id === "local" ? "▱" : "▤"}</span><span>${esc(h.name)}<small>${h.online ? "Connected · " + ago(h.lastSeen) : "Offline · last seen " + ago(h.lastSeen)}</small></span><span class="dot ${h.online ? "" : "off"}"></span></button>`,
    )
    .join("");
  $("#release-version").textContent =
    `v${state.version || "?"} · ${String(state.build || "unknown").slice(0, 8)}`;
  $("#stats").innerHTML = [
    ["Watching", watchedTotal, "Work you’re keeping track of", "◫"],
    ["Active", runningTotal, "Source-reported active work", "↗"],
    [
      "Needs attention",
      groups.length,
      `${attention.length} unresolved update${attention.length === 1 ? "" : "s"}, grouped by work`,
      "◇",
    ],
    [
      "Machines",
      `${connected} / ${state.hosts.length}`,
      "Private connections",
      "▱",
    ],
  ]
    .map(
      ([l, v, s, i]) =>
        `<div class="stat"><div class="stat-label">${l}<span>${i}</span></div><div class="stat-value">${v}</div><small>${s}</small></div>`,
    )
    .join("");
  $("#inbox-count").textContent = groups.length;
  $("#page-name").textContent =
    view === "inbox"
      ? "Action inbox"
      : view === "activity"
        ? "Activity"
        : view === "runtime"
          ? "Runtime"
          : "Work";
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#overview-view").hidden = view !== "overview";
  $("#inbox-view").hidden = view !== "inbox";
  $("#activity-view").hidden = view !== "activity";
  $("#runtime-view").hidden = view !== "runtime";
  renderBriefing();
  if (view === "inbox") renderInbox(groups);
  if (view === "activity") renderActivity();
  if (view === "runtime") renderRuntime();
  let tasks = state.tasks.filter(
    (t) =>
      filter === "all" ||
      (filter === "running" && taskStatus(t) === "active") ||
      (filter === "watched" && t.watched),
  );
  if (search)
    tasks = tasks.filter((t) =>
      (t.title + " " + t.cwd + " " + hostName(t.hostId) + " " + sourceName(t) + " " + contextSummary(t))
        .toLowerCase()
        .includes(search),
    );
  $("#task-count").textContent =
    `${tasks.length}${nextWorkCursor ? " shown" : ""} work items`;
  $("#tasks").innerHTML = tasks.length
    ? tasks
        .map(
          (t) =>
            `<article class="task-card"><div class="task-card-top"><span class="source-badge source-${esc(t.sourceRefs?.[0]?.adapter || "unknown")}">${esc(sourceName(t))}</span><span class="badge ${taskStatus(t)}">${esc(taskStatus(t) === "recent" ? "Recently active" : taskStatus(t) === "offline" ? "Stale / offline" : taskStatus(t))}</span></div><button class="task-open" data-task="${esc(t.key)}">${contextHtml(t, "task-work-context")}<h3>${esc(shortTitle(t))}</h3><p>${esc(plainPreview(t.latestExcerpt || t.latest?.text) || "Open this item to see its recent conversation.")}</p></button>${taskBriefCardHtml(t)}<div class="execution-meta"><span>${esc(t.sourceRefs?.[0]?.profile || t.sourceRefs?.[0]?.agent || t.kind)}</span><span>${esc(t.execution?.host || hostName(t.hostId))}</span>${t.execution?.requestedModel ? `<span title="Requested model">${esc(t.execution.requestedModel)}</span>` : ""}${t.execution?.resolvedModel && t.execution.resolvedModel !== t.execution.requestedModel ? `<span title="Resolved model">→ ${esc(t.execution.resolvedModel)}</span>` : ""}<span>${esc(t.execution?.locality || "unknown")} inference</span><span>${esc(t.statusConfidence || "authoritative")}</span></div><div class="task-meta"><span>${ago(t.updatedAt)}${t.managed ? " · Managed" : ""}</span><button class="watch ${t.watched ? "on" : ""}" data-watch="${esc(t.key)}">${t.watched ? "◉ Watching" : "＋ Watch"}</button></div></article>`,
        )
        .join("")
    : `<div class="empty"><strong>${filter === "watched" ? "Choose your working set." : "No matching work."}</strong>${filter === "watched" ? "Watch agent work you want surfaced in the Action Inbox." : "Try another filter or search."}${filter === "watched" ? '<button class="secondary" data-show-all>Browse recent work →</button>' : ""}</div>`;
  $("#work-more").hidden = !nextWorkCursor;
  const sources = [
    ...new Set([
      ...(state.sources || []).map((source) => source.adapter),
      ...state.tasks.flatMap((task) =>
        (task.sourceRefs || []).map((ref) => ref.adapter),
      ),
    ]),
  ];
  const sourceSelect = $("#source-filter"),
    chosen = sourceSelect.value || sourceFilter;
  sourceSelect.innerHTML =
    '<option value="">All sources</option>' +
    sources
      .map(
        (source) =>
          `<option value="${esc(source)}">${esc({ codex: "Codex", claude: "Claude Code", hermes: "Hermes", openclaw: "OpenClaw", openwebui: "Open WebUI" }[source] || source)}</option>`,
      )
      .join("");
  sourceSelect.value = chosen;
  const hosts = [
      ...new Set(
        [
          ...state.hosts.map((host) => host.id),
          ...state.tasks.map((task) => task.execution?.host || task.hostId),
        ].filter(Boolean),
      ),
    ],
    hostSelect = $("#host-filter"),
    selectedHost = hostSelect.value || hostFilter;
  hostSelect.innerHTML =
    '<option value="">All hosts</option>' +
    hosts
      .map(
        (host) =>
          `<option value="${esc(host)}">${esc(hostName(host))}</option>`,
      )
      .join("");
  hostSelect.value = selectedHost;
  const providers = [
      ...new Set(
        state.tasks.map((task) => task.execution?.provider).filter(Boolean),
      ),
    ],
    providerSelect = $("#provider-filter"),
    selectedProvider = providerSelect.value || providerFilter;
  providerSelect.innerHTML =
    '<option value="">All providers</option>' +
    providers
      .map(
        (provider) =>
          `<option value="${esc(provider)}">${esc(provider)}</option>`,
      )
      .join("");
  providerSelect.value = selectedProvider;
  $("#updated").textContent = demo
    ? "Ephemeral demo · resets on restart"
    : "Last synced " + ago(Math.max(0, ...state.hosts.map((h) => h.lastSeen)));
  document
    .querySelectorAll("[data-filter]")
    .forEach((b) => b.classList.toggle("active", b.dataset.filter === filter));
  renderedPageRevision = pageRevision();
}
function groupIcon(category) {
  return category === "decisions" ? "?" : category === "issues" ? "!" : "↗";
}
function attentionCard(group) {
  const a = group.latest,
    t = group.task,
    count =
      group.count > 1
        ? `<span class="group-count">${group.count} updates</span>`
        : "";
  return `<button class="attention-card" data-action="${esc(a.id)}"><span class="attention-icon">${groupIcon(group.category)}</span><div><strong>${esc(a.title)} ${count}</strong><p>${esc(t ? contextSummary(t) + " · " + shortTitle(t) : a.body)}</p></div><span class="arrow">↗</span></button>`;
}
function renderInbox(groups) {
  const filtered = filterInboxGroups(groups, {
      type: inboxFilter,
      query: inboxSearch,
      sort: inboxSort,
    }),
    visible = filtered.slice(0, inboxLimit);
  state.inboxGroups = new Map(groups.map((group) => [group.key, group]));
  const liveIds = new Set(groups.flatMap((group) => group.resolvableIds));
  for (const id of selectedActions)
    if (!liveIds.has(id)) selectedActions.delete(id);
  document
    .querySelectorAll("[data-inbox-filter]")
    .forEach((button) =>
      button.classList.toggle(
        "active",
        button.dataset.inboxFilter === inboxFilter,
      ),
    );
  $("#inbox-list").innerHTML = visible.length
    ? visible.map(inboxGroupHtml).join("")
    : `<div class="empty"><strong>No matching actions.</strong>Try another filter or search.</div>`;
  $("#inbox-more").hidden = visible.length >= filtered.length;
  $("#inbox-more").textContent =
    `Show ${Math.min(24, filtered.length - visible.length)} more`;
  const selected = selectedActions.size;
  $("#bulk-bar").hidden = !selected;
  $("#bulk-count").textContent = `${selected} selected`;
  const visibleResolvable = visible.flatMap((group) => group.resolvableIds);
  $("#inbox-clear-all").disabled = !visibleResolvable.length;
  $("#inbox-clear-all").textContent = visibleResolvable.length
    ? `Mark visible handled (${visibleResolvable.length})`
    : "Nothing to handle";
}
function inboxGroupHtml(group) {
  const a = group.latest,
    t = group.task,
    checked =
      group.resolvableIds.length &&
      group.resolvableIds.every((id) => selectedActions.has(id)),
    count =
      group.count > 1
        ? `<span class="group-count">${group.count} updates</span>`
        : "",
    category =
      group.category === "decisions"
        ? "Decision"
        : group.category === "issues"
          ? "Issue"
          : "Completed";
  return `<article class="inbox-group ${esc(group.category)}">${group.resolvableIds.length ? `<label class="select-action"><input type="checkbox" data-select-group="${esc(group.key)}" ${checked ? "checked" : ""}><span class="sr-only">Select ${esc(a.title)}</span></label>` : '<span class="select-spacer"></span>'}<span class="attention-icon">${groupIcon(group.category)}</span><button class="inbox-open" data-action="${esc(a.id)}"><span class="inbox-kicker">${category} · ${esc(t ? hostName(t.hostId) : "Workspace")} · ${ago(group.createdAt)}</span><strong>${esc(a.title)} ${count}</strong><p>${esc(t ? contextSummary(t) + " · " + shortTitle(t) : a.body)}</p></button><button class="icon-button" data-action="${esc(a.id)}" aria-label="Review ${esc(a.title)}">↗</button></article>`;
}
function renderActivity() {
  const rows = [
    ...state.commands.map((c) => ({
      at: c.created_at,
      title: `${c.kind} · ${c.status}`,
      text:
        JSON.parse(c.body || "{}").prompt ||
        JSON.parse(c.body || "{}").title ||
        "",
      sub: state.tasks.find((t) => t.key === c.task_key)?.title || "",
      error: c.result ? JSON.parse(c.result).error : null,
    })),
    ...state.actions
      .filter((a) => a.status === "resolved")
      .map((a) => ({
        at: a.updated_at,
        title: "Handled · " + a.title,
        text: "",
        sub: state.tasks.find((t) => t.key === a.task_key)?.title || "",
      })),
  ].sort((a, b) => b.at - a.at);
  $("#activity").innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            `<div class="activity-row"><strong>${esc(r.title)}</strong><p>${esc(r.text || r.sub)}${r.error ? "\n" + esc(r.error) : ""}</p><small>${new Date(r.at).toLocaleString()}</small></div>`,
        )
        .join("")
    : '<div class="empty">Sent instructions and handled decisions will appear here.</div>';
}
function renderRuntime() {
  const runtime = state.runtime || {},
    shadow = state.shadowAnalysis || {},
    sources = state.sources || [],
    sourceCards = sources
      .map(
        (source) =>
          `<article class="runtime-card"><div class="runtime-card-heading"><strong>${esc(source.name)}</strong><span class="badge ${source.online && !source.stale ? "active" : "offline"}">${source.online && !source.stale ? "Connected" : source.stale ? "Stale" : "Offline"}</span></div><p>${esc(source.adapter)} · ${esc(source.hostId)}</p><dl><div><dt>Last snapshot</dt><dd>${ago(source.lastSeen)}</dd></div><div><dt>Captured work</dt><dd>${source.itemCount || 0}</dd></div><div><dt>Active work</dt><dd>${source.activeCount || 0}</dd></div><div><dt>Catalog</dt><dd>${source.models?.length || 0} models</dd></div></dl>${source.error ? `<div class="notice warn">${esc(source.error)}</div>` : ""}</article>`,
      )
      .join(""),
    loaded = (runtime.loadedModels || [])
      .map(
        (model) =>
          `<tr><td>${esc(model.id)}</td><td>${esc(model.size || "—")}</td><td>${model.expiresAt ? esc(new Date(model.expiresAt).toLocaleString()) : "—"}</td></tr>`,
      )
      .join(""),
    catalog = (runtime.catalog || [])
      .map(
        (model) =>
          `<tr><td>${esc(model.id)}</td><td>${esc(model.provider || "Unknown")}</td><td>${esc(model.locality || "Unknown")}</td></tr>`,
      )
      .join(""),
    providers = (runtime.providerSummary || [])
      .map(
        (row) =>
          `<tr><td>${esc(row.provider)}</td><td>${esc(row.locality)}</td><td>${esc(row.count)}</td></tr>`,
      )
      .join(""),
    shadowRecent = (shadow.recent || [])
      .map((entry) => {
        const task = state.tasks.find((item) => item.key === entry.taskKey);
        return `<tr><td>${esc(task ? shortTitle(task) : entry.taskKey)}</td><td><span class="badge ${entry.status === "succeeded" ? "active" : "offline"}">${esc(entry.status)}</span></td><td>${esc(entry.title || entry.error || "—")}</td><td>${entry.latencyMs ? `${Math.round(entry.latencyMs / 100) / 10}s` : "—"}</td></tr>`;
      })
      .join(""),
    shadowTokens =
      (shadow.today?.inputTokens || 0) + (shadow.today?.outputTokens || 0),
    shadowSection = `<section class="runtime-section shadow-runtime"><div class="runtime-card-heading"><div><div class="eyebrow">PROPOSAL-ONLY ANALYSIS</div><h2>AI shadow mode</h2></div><span class="badge ${shadow.enabled && shadow.status !== "budget-exhausted" ? "active" : "offline"}">${esc(shadow.status || "disabled")}</span></div><p class="quiet">${esc(state.supervisorName || "Astra")} records what it recommends against an exact evidence revision. Nothing in this lane can execute a workspace action.</p><div class="runtime-grid"><article class="runtime-card"><strong>Daily budget</strong><dl><div><dt>Calls</dt><dd>${shadow.today?.calls || 0} / ${shadow.limits?.dailyCalls || 20}</dd></div><div><dt>Observable tokens</dt><dd>${shadowTokens.toLocaleString()} / ${(shadow.limits?.observableTokens || 100000).toLocaleString()}</dd></div><div><dt>Usage reported</dt><dd>${shadow.today?.usageReported || 0} calls</dd></div><div><dt>Model</dt><dd>${esc(shadow.model || "—")}</dd></div></dl></article><article class="runtime-card"><strong>Queue</strong><dl><div><dt>Eligible revisions</dt><dd>${shadow.pending || 0}</dd></div><div><dt>Local-only blocked</dt><dd>${shadow.blockedLocal || 0}</dd></div><div><dt>Succeeded</dt><dd>${shadow.total?.succeeded || 0}</dd></div><div><dt>Failed</dt><dd>${shadow.total?.failed || 0}</dd></div></dl>${shadow.lastError ? `<div class="notice warn">${esc(shadow.lastError)}</div>` : ""}${shadow.enabled ? `<button class="secondary" data-shadow-run ${shadow.busy || shadow.status === "budget-exhausted" ? "disabled" : ""}>${shadow.busy ? "Analyzing…" : "Analyze next revision"}</button>` : ""}</article></div><div class="table-wrap"><table><thead><tr><th>Work</th><th>Status</th><th>Recommendation</th><th>Latency</th></tr></thead><tbody>${shadowRecent || '<tr><td colspan="4">No shadow analyses recorded yet.</td></tr>'}</tbody></table></div></section>`;
  $("#runtime-content").innerHTML =
    `${shadowSection}<section class="runtime-section"><div class="section-title"><h2>Connectors</h2><span class="quiet">Metadata only</span></div><div class="runtime-grid">${sourceCards || '<div class="empty compact">No external connectors are configured.</div>'}</div></section><section class="runtime-section"><div class="runtime-card-heading"><h2>GPU broker and router</h2><span class="badge ${runtime.online ? "active" : "offline"}">${runtime.online ? "Connected" : "Unavailable"}</span></div>${runtime.error ? `<div class="notice warn">${esc(runtime.error)}</div>` : ""}<div class="runtime-grid"><article class="runtime-card"><strong>Router state</strong><pre>${esc(runtime.router ? JSON.stringify(runtime.router, null, 2) : "No router status reported.")}</pre></article><article class="runtime-card"><strong>Safe metrics</strong><dl>${
      Object.entries(runtime.metrics || {})
        .map(
          ([key, value]) =>
            `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`,
        )
        .join("") || "<div><dt>Status</dt><dd>No metrics reported</dd></div>"
    }</dl></article></div></section><section class="runtime-section"><h2>Loaded local models</h2><div class="table-wrap"><table><thead><tr><th>Model</th><th>Size</th><th>Expires</th></tr></thead><tbody>${loaded || '<tr><td colspan="3">No source-reported model loads.</td></tr>'}</tbody></table></div></section><section class="runtime-section"><h2>Known model catalog</h2><div class="table-wrap"><table><thead><tr><th>Model</th><th>Provider</th><th>Locality</th></tr></thead><tbody>${catalog || '<tr><td colspan="3">No broker catalog available.</td></tr>'}</tbody></table></div></section><section class="runtime-section"><h2>Observed providers</h2><div class="table-wrap"><table><thead><tr><th>Provider</th><th>Locality</th><th>Work items</th></tr></thead><tbody>${providers || '<tr><td colspan="3">No source-reported providers.</td></tr>'}</tbody></table></div></section>`;
}
function machineGuidance(host) {
  if (state.demo?.enabled)
    return "Synthetic machine health for exploring the diagnostics view. No machine connection was opened.";
  if (host.online && !host.runtimeConnected)
    return "Task snapshots are available, but the Codex runtime is reconnecting. Confirm Codex is signed in on this machine.";
  if (host.runtimeConnected && !host.controlAvailable)
    return (
      host.controlError ||
      "Controls are disabled because this Codex protocol has not passed the compatibility probe."
    );
  if (/ssh/i.test(host.error || ""))
    return "Confirm the machine is awake and that its existing noninteractive SSH connection still works.";
  if (host.error)
    return "Retry the connection. If it still fails, check the machine service and Codex sign-in.";
  return "Snapshots and tested Codex controls are available.";
}
function panelScrollSnapshot() {
  const content = $("#panel-content");
  return {
    scrollTop: content.scrollTop,
    scrollHeight: content.scrollHeight,
    clientHeight: content.clientHeight,
  };
}
function restorePanelScroll(snapshot) {
  if (!snapshot) return;
  const content = $("#panel-content");
  content.scrollTop = scrollTopAfterRender(snapshot, content.scrollHeight);
}
function openMachines(focusId = "") {
  const scroll =
    panel === "machines" && !focusId && !$("#panel").hidden
      ? panelScrollSnapshot()
      : null;
  panel = "machines";
  openPanel("CONNECTED MACHINES", "Connection diagnostics", !scroll);
  const hosts = focusId
    ? [...state.hosts].sort((host) => (host.id === focusId ? -1 : 1))
    : state.hosts;
  $("#panel-content").innerHTML =
    `<div class="machine-list">${hosts.map((host) => `<section class="machine-detail ${host.online ? "online" : "offline"}"><div class="machine-detail-heading"><span class="machine-symbol">${host.id === "local" ? "▱" : "▤"}</span><div><strong>${esc(host.name)}</strong><small>${host.online ? "Connected · " + ago(host.lastSeen) : "Offline · last seen " + ago(host.lastSeen)}</small></div><span class="badge ${host.online ? "running" : "offline"}">${host.online ? "Online" : "Offline"}</span></div><dl><div><dt>Captured tasks</dt><dd>${host.online ? host.inventoryCount || 0 : "Unavailable"}</dd></div><div><dt>Codex runtime</dt><dd>${host.runtimeConnected ? "Connected" : "Not connected"}</dd></div><div><dt>Control protocol</dt><dd>${host.controlAvailable ? `Tested · ${esc(host.protocolVersion)}` : `Disabled · ${esc(host.protocolVersion || "unknown")}`}</dd></div><div><dt>Saved projects</dt><dd>${host.projectsError ? "Refresh failed" : "Available"}</dd></div></dl>${host.error ? `<div class="notice warn">${esc(host.error)}</div>` : ""}${host.projectsError ? `<div class="notice warn">Project list: ${esc(host.projectsError)}</div>` : ""}<p>${esc(machineGuidance(host))}</p>${state.demo?.enabled ? "" : `<button class="secondary" data-retry-host="${esc(host.id)}">Retry connection</button>`}</section>`).join("")}</div>`;
  restorePanelScroll(scroll);
}
function openPanel(eyebrow, name, resetScroll = true) {
  $("#panel").hidden = false;
  if (resetScroll) $("#panel-content").scrollTop = 0;
  $("#panel-eyebrow").textContent = eyebrow;
  $("#panel-title").textContent = name;
}
async function openTask(key) {
  const scroll =
      panel === key && !$("#panel").hidden ? panelScrollSnapshot() : null,
    previousDetail = detail;
  panel = key;
  if (!scroll) detail = null;
  const t = state.tasks.find((t) => t.key === key);
  openPanel("WORK DETAILS", title(t), !scroll);
  if (!scroll)
    $("#panel-content").innerHTML =
      '<div class="loading">Reading bounded recent detail from the source…</div>';
  try {
    const d = await api("/api/work-items/" + encodeURIComponent(key));
    if (panel !== key) return;
    detail = d;
    renderDetail(d, scroll);
  } catch (e) {
    if (panel !== key) return;
    if (scroll) detail = previousDetail;
    else
      $("#panel-content").innerHTML =
        `<div class="notice warn">${esc(e.message)}</div><p>Last known state remains in your workspace.</p>`;
  }
}
function signalHtml(signal, t) {
  const action = signal.actionId
    ? `<button class="signal-action" data-action="${esc(signal.actionId)}">${esc(signal.actionLabel)} →</button>`
    : signal.focusComposer
      ? t.controlAvailable === false
        ? ""
        : !t.managed && t.owned
          ? `<a class="signal-action" href="codex://threads/${encodeURIComponent(t.id)}">Open in Codex ↗</a>`
          : `<button class="signal-action" data-focus-compose>${esc(signal.actionLabel)} →</button>`
      : "";
  return `<section class="task-signal ${esc(signal.kind)}" role="status" aria-label="${esc(signal.label)}"><span class="signal-icon" aria-hidden="true">${esc(signal.icon)}</span><div class="signal-copy"><div class="signal-label">${esc(signal.label)}</div><strong>${esc(signal.title)}</strong><p>${esc(signal.body)}</p></div>${action}</section>`;
}
function continuationChoiceHtml(t, status, controls) {
  const liveApproval = state.actions.some(
    (action) =>
      action.kind === "approval" &&
      action.status === "open" &&
      (action.taskKey || action.task_key) === t.key,
  );
  if (
    !controls ||
    !t.managed ||
    !["paused", "waiting"].includes(status) ||
    liveApproval
  )
    return "";
  return `<section class="task-signal next" aria-label="Choose what happens next"><span class="signal-icon" aria-hidden="true">?</span><div class="signal-copy"><div class="signal-label">YOUR CHOICE</div><strong>No AI recommendation is ready to approve yet</strong><p>This task was interrupted before its recommendation checkpoint. Continue resumes from the last safe checkpoint; it does not approve an old request. You can also stop this direction or tell the agent what to do instead.</p></div><div class="actions-row"><button class="primary" data-continue="${esc(t.key)}">Continue task</button><button class="secondary" data-stop="${esc(t.key)}">Don’t continue</button><button class="secondary" data-focus-compose>Give a different direction</button></div></section>`;
}
function repositoryHtml(g) {
  if (!g.available)
    return `<details class="technical-details"><summary><span>Repository state</span><small>Unavailable</small></summary><p>${esc(g.error || "No Git repository found.")}</p></details>`;
  const changed = !!(g.status || g.diffStat || g.stagedStat);
  return `<details class="technical-details"><summary><span>Repository state</span><small>${esc(g.branch || "Detached HEAD")} · ${changed ? "Local changes" : "Clean"}</small></summary><div class="repo-summary">${esc(g.branch || "Detached HEAD")} · ${esc(g.head?.slice(0, 8))}<br>${g.upstream ? `${g.ahead ?? 0} ahead · ${g.behind ?? 0} behind ${esc(g.upstream)}` : "No upstream branch configured"}<br><small>Observed now from local refs; no fetch was run.</small></div><pre>${esc(g.status || "Working tree is clean.")}${g.diffStat ? "\n\nUnstaged changes\n" + esc(g.diffStat) : ""}${g.stagedStat ? "\n\nStaged changes\n" + esc(g.stagedStat) : ""}</pre></details>`;
}
function reviewHtml(messages, g) {
  const summary = reviewSummary(messages, g),
    final = summary.final;
  return `<section class="result-review" id="latest-result"><div class="result-heading"><div><div class="eyebrow">LATEST RESULT</div><h3>${final ? "What the agent reported" : "No final response yet"}</h3></div>${final?.at ? `<time>${new Date(final.at).toLocaleString()}</time>` : ""}</div><div class="review-evidence"><div><span>Repository</span><strong>${esc(summary.repository)}</strong><small>${esc(summary.branch)}</small></div><div><span>Changed files</span><strong>${summary.changedFiles}</strong><small>Observed in Git status</small></div><div class="verification"><span>Verification</span><strong>${esc(summary.verification)}</strong></div></div>${final ? `<article class="message assistant final result-message"><div class="rich-text">${renderRichText(final.text)}</div></article>` : '<div class="empty compact">The agent has not published a final response for this turn.</div>'}</section>`;
}
function renderDemoDetail(t, g, status, content, messages, scroll) {
  const summary = reviewSummary(messages, g),
    earlier = summary.final
      ? messages.filter((message) => message.id !== summary.final.id)
      : messages,
    provenance = (t.sourceRefs || [])
      .map(
        (source) =>
          `<li><strong>${esc(sourceName({ sourceRefs: [source] }))}</strong> · ${esc(source.profile || source.agent || source.nativeId)} · ${esc(source.hostId)}</li>`,
      )
      .join("");
  content.innerHTML = `<div class="task-context"><div><span class="source-badge source-${esc(t.sourceRefs?.[0]?.adapter || "unknown")}">${esc(sourceName(t))}</span><span class="badge ${status}">${esc(status === "recent" ? "Recently active" : status)}</span></div><span class="demo-control-note">Controls disabled in demo</span></div><div class="ownership-note">Synthetic work detail. No agent or source system is connected.</div>${taskBriefDetailHtml(t)}<div class="execution-panel"><span>${esc(t.execution?.host || t.hostId)}</span><span>${esc(t.execution?.requestedModel || "Model not reported")}</span>${t.execution?.resolvedModel ? `<span>Resolved: ${esc(t.execution.resolvedModel)}</span>` : ""}<span>${esc(t.execution?.locality || "unknown")} inference</span><span>${esc(t.statusConfidence)} status</span></div>${reviewHtml(messages, g)}<section class="conversation-section"><div class="conversation-heading"><h3>Recent sample conversation</h3><span>Synthetic and bounded</span></div><div class="messages">${conversationHtml(earlier.slice(-30)) || '<div class="empty compact">No earlier conversation items are available.</div>'}</div></section>${repositoryHtml(g)}<details class="technical-details"><summary><span>Provenance</span><small>${t.sourceRefs?.length || 0} source${t.sourceRefs?.length === 1 ? "" : "s"}</small></summary><ul>${provenance}</ul></details>`;
  restorePanelScroll(scroll);
}
function renderDetail(d, scroll) {
  const t = d.task,
    g = d.git,
    status = taskStatus(t),
    content = $("#panel-content"),
    messages = compactConversation(d.messages),
    codex = t.sourceRefs?.some((source) => source.adapter === "codex");
  if (state.demo?.enabled) {
    renderDemoDetail(t, g, t.status, content, messages, scroll);
    return;
  }
  if (!codex) {
    const links = (t.sourceRefs || [])
        .filter((source) => source.deepLink)
        .map(
          (source) =>
            `<a href="${esc(source.deepLink)}" target="_blank" rel="noreferrer">Open in ${esc(sourceName({ sourceRefs: [source] }))} ↗</a>`,
        )
        .join(""),
      provenance = (t.sourceRefs || [])
        .map(
          (source) =>
            `<li><strong>${esc(sourceName({ sourceRefs: [source] }))}</strong> · ${esc(source.profile || source.agent || source.nativeId)} · ${esc(source.hostId)}</li>`,
        )
        .join("");
    content.innerHTML = `<div class="task-context"><div><span class="source-badge source-${esc(t.sourceRefs?.[0]?.adapter || "unknown")}">${esc(sourceName(t))}</span><span class="badge ${status}">${esc(status === "recent" ? "Recently active" : status)}</span></div><div class="actions-row">${links}<button class="secondary" data-task="${esc(t.key)}">Refresh</button></div></div><div class="ownership-note">Observed here. ThreadHelm does not send, pause, archive, or approve work in this source yet.</div>${taskBriefDetailHtml(t)}<div class="execution-panel"><span>${esc(t.execution?.host || t.hostId)}</span><span>${esc(t.execution?.requestedModel || "Model not reported")}</span>${t.execution?.resolvedModel ? `<span>Resolved: ${esc(t.execution.resolvedModel)}</span>` : ""}<span>${esc(t.execution?.locality || "unknown")} inference</span><span>${esc(t.statusConfidence)} status</span></div><section class="conversation-section"><div class="conversation-heading"><h3>Recent bounded detail</h3><span>Up to 30 entries; full history stays at the source</span></div><div class="messages">${conversationHtml(messages) || '<div class="empty compact">No recent detail was returned.</div>'}</div></section><details class="technical-details"><summary><span>Provenance</span><small>${t.sourceRefs?.length || 0} source${t.sourceRefs?.length === 1 ? "" : "s"}</small></summary><ul>${provenance}</ul></details>`;
    restorePanelScroll(scroll);
    return;
  }
  const signal = conversationSignal({ ...t, status }, state.actions),
    summary = reviewSummary(messages, g),
    earlier = summary.final
      ? messages.filter((message) => message.id !== summary.final.id)
      : messages,
    inactive = !["active", "running", "recent", "offline"].includes(status),
    controls = t.controlAvailable !== false,
    sendDisabled = !controls || (!t.managed && t.owned),
    sendLabel = !controls
      ? "Controls disabled — open in Codex"
      : !t.managed && t.owned
        ? "Continue in Codex — this task is desktop-owned"
        : "Send to agent →";
  content.innerHTML = `<div class="task-context"><div><span class="badge ${status}">${esc(status === "idle" ? "Turn complete" : status === "offline" ? "Stale / offline" : status)}</span><span>${esc(hostName(t.hostId))} · ${esc(repo(t))}</span></div><div class="actions-row"><a href="codex://threads/${encodeURIComponent(t.id)}">Open in Codex ↗</a>${controls && t.managed && status === "active" ? `<button class="secondary" data-pause="${esc(t.key)}">Pause turn</button>` : ""}${controls && inactive ? `<button class="secondary" data-archive="${esc(t.key)}">Archive task</button>` : ""}<button class="secondary" data-task="${esc(t.key)}">Refresh</button></div></div>${signalHtml(signal, t)}${continuationChoiceHtml(t, status, controls)}${!controls ? `<div class="ownership-note warn">${esc(t.controlReason || "Controls are disabled because this Codex protocol has not passed the compatibility probe.")}</div>` : !t.managed ? `<div class="ownership-note ${t.owned ? "warn" : ""}">${t.owned ? "This task is controlled by Codex desktop. Reply there to continue it." : "Sending a reply will bring this available task under dashboard control."}</div>` : ""}${taskBriefDetailHtml(t)}${reviewHtml(messages, g)}<section class="conversation-section"><div class="conversation-heading"><h3>Earlier conversation and activity</h3><span>Technical activity is collapsed</span></div><div class="messages">${conversationHtml(earlier.slice(-30)) || '<div class="empty compact">No earlier conversation items are available.</div>'}</div></section><form class="compose" id="send-form"><label for="send-input">Reply or give the agent its next instruction</label><textarea id="send-input" rows="4" placeholder="Write a clear answer or describe what should happen next…" ${controls ? "" : "disabled"}>${esc(drafts.get(t.key) || "")}</textarea><button class="primary full" type="submit" ${sendDisabled ? "disabled" : ""}>${sendLabel}</button></form>${repositoryHtml(g)}`;
  restorePanelScroll(scroll);
  $("#send-input").addEventListener("input", (e) =>
    drafts.set(t.key, e.target.value),
  );
  $("#send-form").onsubmit = async (e) => {
    e.preventDefault();
    const prompt = $("#send-input").value.trim();
    if (!prompt) return;
    await perform(e.submitter, async () => {
      await api("/api/send", {
        key: t.key,
        prompt,
        requestId: crypto.randomUUID(),
      });
      drafts.delete(t.key);
      $("#send-input").value = "";
      toast("Instruction accepted by Codex. Its result will appear here.");
    });
  };
}
function conversationHtml(messages) {
  let html = "",
    technical = [];
  const flush = () => {
    if (!technical.length) return;
    const commands = technical
        .filter((m) => m.role === "tool")
        .reduce((n, m) => n + (m.repeatCount || 1), 0),
      changes = technical
        .filter((m) => m.role === "change")
        .reduce((n, m) => n + (m.repeatCount || 1), 0),
      parts = [
        commands && `${commands} command event${commands === 1 ? "" : "s"}`,
        changes && `${changes} file update${changes === 1 ? "" : "s"}`,
      ].filter(Boolean);
    html += `<details class="activity-group"><summary><span class="event-icon" aria-hidden="true">›</span><span><strong>Technical activity</strong><small>${parts.join(" · ")} · ${technical.length} unique</small></span></summary><div class="activity-group-items">${technical.map(messageHtml).join("")}</div></details>`;
    technical = [];
  };
  for (const message of messages) {
    if (message.role === "tool" || message.role === "change")
      technical.push(message);
    else {
      flush();
      html += messageHtml(message);
    }
  }
  flush();
  return html;
}
function messageHtml(m) {
  const when = m.at
    ? new Date(m.at).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  if (m.role === "tool" || m.role === "change") {
    const command = m.role === "tool",
      label = command ? "Command" : "Files changed",
      lines = String(m.text).split("\n").filter(Boolean),
      summary = command
        ? plainPreview(m.text, 120)
        : `${lines.length} file${lines.length === 1 ? "" : "s"}`,
      repeat = m.repeatCount > 1 ? ` · repeated ${m.repeatCount}×` : "";
    return `<details class="timeline-event"><summary><span class="event-icon" aria-hidden="true">${command ? "›" : "±"}</span><span><strong>${label}${repeat}</strong><small>${esc(summary)}${m.status ? " · " + esc(m.status) : ""}${m.exitCode != null ? " · exit " + esc(m.exitCode) : ""}</small></span></summary><div class="event-detail"><pre>${esc(m.text)}${m.output ? "\n\n" + esc(m.output) : ""}</pre></div></details>`;
  }
  const user = m.role === "user",
    final = m.phase === "final_answer";
  return `<article class="message ${user ? "user" : "assistant"} ${final ? "final" : ""}"><div class="message-meta"><span>${user ? "You" : final ? "✓ Final response" : "Agent update"}</span>${when ? `<time>${esc(when)}</time>` : ""}</div><div class="rich-text">${renderRichText(m.text)}</div>${m.output ? `<details class="message-output"><summary>Show command output</summary><pre>${esc(m.output)}</pre></details>` : ""}</article>`;
}
function coordinatorActionTarget(action) {
  if (action.taskKey)
    return (
      title(state.tasks.find((task) => task.key === action.taskKey)) ||
      action.taskKey
    );
  if (action.type === "create") return action.title || action.cwd;
  if (action.type === "resolve")
    return `${action.actionIds?.length || 0} inbox items`;
  if (action.type === "approval") return "Pending decision";
  return "Workspace";
}
function coordinatorActions(message) {
  const executions = new Map(
    (message.body.executions || []).map((result) => [result.actionId, result]),
  );
  return (message.body.actions || [])
    .map((action) => {
      const result = executions.get(action.id),
        status = result?.status || "proposed",
        icon = status === "accepted" ? "✓" : status === "proposed" ? "→" : "!";
      return `<div class="proposal coordinator-action ${esc(status)}"><small>${esc(action.type.toUpperCase())} · ${esc(coordinatorActionTarget(action))}</small><p>${esc(action.reason)}</p><div class="execution-result ${esc(status)}">${icon} ${esc(result?.summary || "Proposal only — no workspace action was executed.")}</div></div>`;
    })
    .join("");
}
function coordinatorUsage(message) {
  const usage = message.body?.usage;
  if (!usage) return "";
  const input = usage.inputTokens ?? usage.estimatedInputTokens,
    output = usage.outputTokens ?? usage.estimatedOutputTokens,
    limit = Math.round((usage.maxInputChars || 0) / 4),
    detail = usage.inputTokens != null ? "reported" : "estimated",
    tasks = usage.context?.tasks,
    inbox = usage.context?.inbox;
  return `<div class="quiet coordinator-usage">Context: ${Number(input || 0).toLocaleString()} ${esc(detail)} input tokens${limit ? ` of ${limit.toLocaleString()} available` : ""} · ${Number(output || 0).toLocaleString()} output tokens${tasks ? ` · ${tasks.included}/${tasks.available} tasks` : ""}${inbox ? ` · ${inbox.included}/${inbox.available} inbox items` : ""}</div>`;
}
function renderChat() {
  const live = $("#chat-live"),
    existing = panel === "chat" && !$("#panel").hidden && !!live,
    scroll = existing ? panelScrollSnapshot() : null;
  panel = "chat";
  openPanel(
    `${String(state.supervisorName || "Astra").toUpperCase()} COORDINATOR`,
    "Review recommendations for your workspace.",
    !existing,
  );
  if (!existing) {
    const draft = drafts.get("chat") || "";
    $("#panel-content").innerHTML =
      `<div class="notice"><strong>Recommendations only.</strong><br>The coordinator analyzes your workspace and proposes actions for review. Actions shown here do not execute automatically.</div><div id="chat-live"></div><form id="chat-form" class="compose"><textarea id="chat-input" rows="3" placeholder="Review the workspace and tell me what needs attention…">${esc(draft)}</textarea><button class="primary full" type="submit">Ask coordinator →</button></form>`;
    $("#chat-input").oninput = (e) => drafts.set("chat", e.target.value);
    $("#chat-form").onsubmit = async (e) => {
      e.preventDefault();
      const message = $("#chat-input").value.trim();
      if (!message) return;
      drafts.delete("chat");
      $("#chat-input").value = "";
      await perform(e.submitter, () => api("/api/chat", { message }));
    };
  }
  const messages = $("#chat-live"),
    input = $("#chat-input"),
    button = $('#chat-form button[type="submit"]');
  messages.innerHTML = `<div class="messages">${state.chat.length ? state.chat.map((m) => `<article class="message ${m.role === "user" ? "user" : "assistant"}"><div class="message-meta"><span>${m.role === "user" ? "You" : "Coordinator"}${m.body.model ? ` · ${esc(m.body.model)}` : ""}</span></div><div class="rich-text">${renderRichText(m.body.answer)}</div>${coordinatorUsage(m)}${coordinatorActions(m)}${(m.body.dispatches || []).map((d) => `<div class="proposal"><small>LEGACY PROPOSAL · ${esc(title(state.tasks.find((t) => t.key === d.taskKey)))}</small><p>${esc(d.prompt)}</p><button class="secondary" data-proposal-key="${esc(d.taskKey)}" data-proposal-prompt="${esc(d.prompt)}">Send instruction →</button></div>`).join("")}</article>`).join("") : '<div class="empty"><strong>Your workspace has an AI coordinator.</strong>Try “Review everything and tell me what needs attention first.”</div>'}</div>${state.chatBusy ? '<div class="loading">Coordinator is reviewing the workspace and preparing recommendations…</div>' : ""}`;
  input.disabled = !!state.chatBusy;
  button.disabled = !!state.chatBusy;
  restorePanelScroll(scroll);
}
async function openAction(id) {
  const a = state.actions.find((action) => action.id === id);
  if (!a) return;
  panel = "action:" + id;
  openPanel(
    a.kind === "approval"
      ? "AUTHORIZATION REQUEST"
      : a.kind === "blocked"
        ? "TASK DECISION"
        : "RESULT REVIEW",
    a.title,
  );
  const t = [...state.tasks, ...(state.inboxItems || [])].find(
    (task) => task.key === a.task_key,
  );
  if (a.kind === "approval" || !t) {
    renderAction(a, t);
    return;
  }
  $("#panel-content").innerHTML =
    '<div class="loading">Loading the latest result and repository evidence…</div>';
  try {
    const d = await api("/api/work-items/" + encodeURIComponent(t.key));
    if (panel === "action:" + id) renderAction(a, t, d);
  } catch (e) {
    if (panel === "action:" + id) renderAction(a, t, null, e.message);
  }
}
function renderAction(a, t, d, error = "") {
  const p = a.payload,
    approvalSubjectLabel = approvalSubject(p),
    approvalHost = state.hosts.find((host) => host.id === p?.hostId),
    approvalControl = !approvalHost || approvalHost.controlAvailable,
    canDecideExpired =
      a.kind === "approval" &&
      a.status === "expired" &&
      !state.demo?.enabled &&
      approvalControl &&
      !!t?.managed,
    expiredRecoveryNote = !approvalControl
      ? "A compatibility update is needed before Astra can continue this request."
      : !t
        ? "The original task is no longer available to Astra."
        : !t.managed
          ? "Codex desktop owns this task, so the decision must be completed there."
          : `Allowing this will resume the managed agent only for this exact ${approvalSubjectLabel}.`;
  let form = "";
  if (
    a.kind === "approval" &&
    a.status === "open" &&
    !state.demo?.enabled &&
    approvalControl
  ) {
    if (p?.method === "item/tool/requestUserInput") {
      form =
        (p.params.questions || [])
          .map(
            (q) =>
              `<label>${esc(q.header || "Question")}: ${esc(q.question)}<input data-question="${esc(q.id)}" list="opts-${esc(q.id)}" required><datalist id="opts-${esc(q.id)}">${(q.options || []).map((o) => `<option value="${esc(o.label)}">${esc(o.description)}</option>`).join("")}</datalist></label>`,
          )
          .join("") +
        '<button class="primary" data-decision="answer">Submit answers</button>';
    } else {
      const allow = [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
      ].includes(p?.method);
      form = `<div class="actions-row">${allow ? `<button class="primary" data-decision="accept">Allow this ${esc(approvalSubjectLabel)}</button>` : ""}<button class="danger" data-decision="${p?.params?.availableDecisions && !p.params.availableDecisions.includes("decline") && p.params.availableDecisions.includes("cancel") ? "cancel" : "decline"}">Do not allow this ${esc(approvalSubjectLabel)}</button></div>${!allow ? '<div class="notice warn">Complete this connector’s form in Codex. You can decline it here.</div>' : ""}`;
    }
  }
  const fallbackMessages = t?.latest
      ? [t.latest]
      : [
          {
            id: "action",
            role: "assistant",
            phase: "final_answer",
            text: a.body,
            at: a.created_at,
          },
        ],
    fallbackGit = {
      available: false,
      error: error || "Live repository evidence is unavailable.",
    },
    review =
      a.kind === "approval"
        ? `<section class="approval-request"><div class="eyebrow">AGENT’S EXACT REQUEST</div><div class="message assistant"><div class="rich-text">${renderRichText(a.body)}</div></div></section>`
        : reviewHtml(d?.messages || fallbackMessages, d?.git || fallbackGit);
  const ref = t?.sourceRefs?.[0],
    sourceLink = ref?.deepLink
      ? `<a href="${esc(ref.deepLink)}" ${ref.adapter === "codex" ? "" : 'target="_blank" rel="noreferrer"'}>Open in ${esc(sourceName(t))} ↗</a>`
      : "";
  const blockedChoices =
    a.kind !== "blocked"
      ? ""
      : !t
        ? '<div class="notice warn">The original task is no longer available, so Astra cannot continue it.</div>'
        : !t.sourceRefs?.some((source) => source.adapter === "codex")
          ? `<div class="notice warn"><strong>This source owns the next move.</strong><br>${sourceLink ? "Open it there to resolve the blocker." : "This source does not expose a remote action, so resolve the blocker in the source workspace."}</div>`
          : t.controlAvailable === false
            ? `<div class="notice warn">${esc(t.controlReason || "Astra cannot control this Codex task until its compatibility check succeeds.")}</div>`
            : t.owned && !t.managed
              ? `<section class="action-choice"><div><div class="eyebrow">YOUR DECISION</div><strong>Choose what this task should do next</strong><p>Codex desktop owns this task. Open it there to continue, redirect, or leave it stopped.</p></div><a class="primary" href="codex://threads/${encodeURIComponent(t.id)}">Open in Codex to decide ↗</a></section>`
              : `<section class="action-choice"><div><div class="eyebrow">YOUR DECISION</div><strong>Choose what this task should do next</strong><p>Continue resumes from the last safe checkpoint. Don’t continue tells the agent to stop and wait for a new direction.</p></div><div class="actions-row"><button class="primary" data-continue="${esc(t.key)}">Continue from safe checkpoint</button><button class="secondary" data-stop="${esc(t.key)}">Don’t continue</button><button class="secondary" data-focus-compose>Give a different direction</button></div></section>`;
  $("#panel-content").innerHTML =
    `${t ? `<p class="quiet">${esc(hostName(t.hostId))} · ${esc(title(t))}</p>` : ""}${a.kind === "approval" ? approvalContextHtml(p) : ""}${a.kind === "failure" || a.kind === "delivery" ? `<div class="notice warn"><strong>${esc(a.title)}</strong><br>${esc(a.body)}</div>` : ""}${review}${blockedChoices}${state.demo?.enabled && a.kind === "approval" ? '<div class="notice"><strong>Sample decision only.</strong><br>Approval controls are disabled because no agent is connected.</div>' : ""}${!approvalControl && a.kind === "approval" ? `<div class="notice warn"><strong>Approval controls disabled.</strong><br>${esc(approvalHost?.controlError || "This Codex protocol has not passed the compatibility probe.")}</div>` : ""}${error ? `<div class="notice warn">Live evidence could not be refreshed: ${esc(error)}</div>` : ""}${p ? `<details class="technical-details"><summary><span>Technical request details</span><small>Optional</small></summary><pre>${esc(JSON.stringify(p.params, null, 2))}</pre></details>` : ""}${a.status === "expired" ? `<div class="notice warn"><strong>This authorization expired before it was acted on.</strong><br>${esc(expiredRecoveryNote)}</div>` : ""}${a.status === "responding" ? '<div class="notice">Decision submitted. Waiting for Codex to confirm resolution.</div>' : ""}<form id="decision-form">${form}</form><div class="actions-row">${canDecideExpired ? `<button class="primary" data-expired-approval="${esc(a.id)}" data-expired-decision="accept">Allow this exact ${esc(approvalSubjectLabel)} and continue</button><button class="danger" data-expired-approval="${esc(a.id)}" data-expired-decision="decline">Do not allow this ${esc(approvalSubjectLabel)}</button>` : ""}${t ? `<button class="secondary" data-task="${esc(t.key)}">Open full work</button>${sourceLink}` : ""}${(a.kind !== "approval" && a.status === "open") || a.status === "expired" ? `<button class="secondary" data-resolve="${esc(a.id)}">${a.status === "expired" ? "Dismiss expired request" : "Mark handled"}</button>` : ""}</div><p class="quiet">Created ${new Date(a.created_at).toLocaleString()}</p>`;
  const decision = $("#decision-form");
  if (decision)
    decision.onsubmit = async (e) => {
      e.preventDefault();
      const action = e.submitter?.dataset.decision;
      if (!action) return;
      const answers = {};
      document
        .querySelectorAll("[data-question]")
        .forEach((input) => (answers[input.dataset.question] = input.value));
      await perform(e.submitter, async () => {
        await api("/api/approval", { id: a.id, action, answers });
        await refresh();
        await openAction(a.id);
      });
    };
}
async function perform(button, fn) {
  if (button) button.disabled = true;
  try {
    await fn();
    await refresh();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}
function newTask() {
  const dlg = $("#new-dialog");
  $("#create-host").innerHTML = state.hosts
    .map(
      (h) =>
        `<option value="${esc(h.id)}" ${h.online && h.controlAvailable ? "" : "disabled"}>${esc(h.name)}${!h.online ? " · offline" : !h.controlAvailable ? " · controls disabled" : ""}</option>`,
    )
    .join("");
  $("#create-project-search").value = "";
  fillProjects();
  dlg.showModal();
}
function fillProjects() {
  allCreateProjects = projectsForHost(
    state.projects || [],
    $("#create-host").value,
  );
  const needle = $("#create-project-search").value.trim().toLowerCase();
  createProjects = allCreateProjects.filter(
    (project) =>
      !needle ||
      `${project.choiceLabel} ${project.roots.join(" ")}`
        .toLowerCase()
        .includes(needle),
  );
  const select = $("#create-project");
  select.innerHTML = createProjects.length
    ? createProjects
        .map(
          (project, index) =>
            `<option value="${index}">${esc(project.choiceLabel)}</option>`,
        )
        .join("")
    : '<option value="" disabled>No matching projects</option>';
  select.disabled = !createProjects.length;
  fillCheckouts();
}
function fillCheckouts() {
  const project = createProjects[Number($("#create-project").value)],
    select = $("#create-cwd");
  select.innerHTML = project
    ? project.roots
        .map((path) => `<option value="${esc(path)}">${esc(path)}</option>`)
        .join("")
    : '<option value="" disabled>No working directory available</option>';
  select.disabled = !project;
  updateCheckoutStatus();
}
function updateCheckoutStatus() {
  const hostId = $("#create-host").value,
    cwd = $("#create-cwd").value,
    mode = $("#create-mode").value,
    assessment = cwd
      ? checkoutAssessment(state.tasks, hostId, cwd, taskStatus)
      : {
          level: "clear",
          message: "Choose a checkout.",
          active: [],
          related: [],
          branches: [],
        },
    status = $("#checkout-status"),
    isolatedMessage = assessment.active.length
      ? `${assessment.active.length} active task${assessment.active.length === 1 ? "" : "s"} use this base checkout. The new worktree will keep this task’s edits separate.`
      : assessment.related.length
        ? `${assessment.related.length} recent task${assessment.related.length === 1 ? "" : "s"} use this base checkout. The new worktree will keep edits separate.`
        : "No other recent task is using this checkout.";
  status.className = `checkout-status ${mode === "isolated" ? "clear" : assessment.level}`;
  status.innerHTML = `<strong>${mode === "isolated" ? "Isolated from existing work" : "Using the checkout directly"}</strong><span>${esc(mode === "isolated" ? isolatedMessage : assessment.message)}</span>${assessment.branches.length ? `<small>Observed branch${assessment.branches.length === 1 ? "" : "es"}: ${esc(assessment.branches.join(", "))}</small>` : ""}${mode === "existing" && assessment.active.length ? '<label class="overlap-confirm"><input id="confirm-overlap" type="checkbox"> I understand that active tasks may edit the same files.</label>' : ""}`;
  $("#create-notice").innerHTML =
    mode === "isolated"
      ? "A new <code>codex/…</code> branch and sibling worktree will be created before the task starts."
      : "The task will write directly in this checkout. Existing uncommitted changes remain in place.";
  updateCreateSubmit();
}
function updateCreateSubmit() {
  const project = createProjects[Number($("#create-project").value)],
    host = state.hosts.find((value) => value.id === $("#create-host").value),
    busyExisting =
      $("#create-mode").value === "existing" &&
      $("#checkout-status").classList.contains("busy"),
    confirmed = !busyExisting || $("#confirm-overlap")?.checked;
  $('#create-form button[type="submit"]').disabled =
    !host?.controlAvailable ||
    !project ||
    !$("#create-cwd").value ||
    !confirmed;
}
$("#create-host").onchange = () => {
  $("#create-project-search").value = "";
  fillProjects();
};
$("#create-project-search").oninput = fillProjects;
$("#create-project").onchange = fillCheckouts;
$("#create-cwd").onchange = updateCheckoutStatus;
$("#create-mode").onchange = updateCheckoutStatus;
$("#new-task").onclick = newTask;
$("#close-new").onclick = () => $("#new-dialog").close();
$("#create-form").onsubmit = async (e) => {
  e.preventDefault();
  const project = createProjects[Number($("#create-project").value)],
    isolate = $("#create-mode").value === "isolated";
  if (!project)
    return toast("Choose a project before starting the task.", true);
  await perform(e.submitter, async () => {
    const r = await api("/api/create", {
      requestId: crypto.randomUUID(),
      hostId: $("#create-host").value,
      projectId: project.id,
      cwd: $("#create-cwd").value,
      title: $("#create-title").value,
      prompt: $("#create-prompt").value,
      isolate,
    });
    $("#new-dialog").close();
    $("#create-form").reset();
    await refresh();
    toast(
      r.result?.worktree
        ? `Task started in isolated worktree ${r.result.worktree.branch}.`
        : `Task started in ${project.name}.`,
    );
    if (r.result?.key) await openTask(r.result.key);
  });
};
async function resolveMany(
  ids,
  button,
  message = "Inbox items marked handled.",
) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  await perform(button, async () => {
    await api("/api/actions/resolve-many", { ids: unique });
    for (const id of unique) selectedActions.delete(id);
    toast(message);
  });
}
function visibleInboxGroups() {
  return filterInboxGroups([...state.inboxGroups.values()], {
    type: inboxFilter,
    query: inboxSearch,
    sort: inboxSort,
  }).slice(0, inboxLimit);
}
function queueWorkReload() {
  clearTimeout(workFilterTimer);
  workFilterTimer = setTimeout(
    () =>
      void loadWork(true)
        .then(render)
        .catch((error) => toast(error.message, true)),
    250,
  );
}
$("#search").oninput = (e) => {
  search = e.target.value.toLowerCase();
  queueWorkReload();
};
$("#source-filter").onchange = (e) => {
  sourceFilter = e.target.value;
  void loadWork(true).then(render);
};
$("#host-filter").onchange = (e) => {
  hostFilter = e.target.value;
  void loadWork(true).then(render);
};
$("#kind-filter").onchange = (e) => {
  kindFilter = e.target.value;
  void loadWork(true).then(render);
};
$("#status-filter").onchange = (e) => {
  statusFilter = e.target.value;
  if (statusFilter) filter = "all";
  void loadWork(true).then(render);
};
$("#provider-filter").onchange = (e) => {
  providerFilter = e.target.value;
  void loadWork(true).then(render);
};
$("#locality-filter").onchange = (e) => {
  localityFilter = e.target.value;
  void loadWork(true).then(render);
};
$("#model-filter").oninput = (e) => {
  modelFilter = e.target.value.trim();
  queueWorkReload();
};
$("#work-more").onclick = async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    await loadWork(false);
    render();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
};
$("#inbox-search").oninput = (e) => {
  inboxSearch = e.target.value;
  inboxLimit = 24;
  render();
};
$("#inbox-sort").onchange = (e) => {
  inboxSort = e.target.value;
  render();
};
$("#close-panel").onclick = () => {
  panel = null;
  $("#panel").hidden = true;
};
$("#open-coordinator").onclick = renderChat;
$("#connection").onclick = () => openMachines();
$("#refresh").onclick = (e) =>
  perform(e.currentTarget, () => api("/api/refresh", {}));
$("#view-inbox").onclick = () => {
  view = "inbox";
  inboxLimit = 24;
  render();
};
$("#inbox-more").onclick = () => {
  inboxLimit += 24;
  render();
};
$("#bulk-resolve").onclick = (e) =>
  resolveMany([...selectedActions], e.currentTarget);
$("#inbox-clear-all").onclick = (e) =>
  resolveMany(
    visibleInboxGroups().flatMap((group) => group.resolvableIds),
    e.currentTarget,
    "Visible inbox items marked handled.",
  );
document.addEventListener("change", (e) => {
  if (e.target.matches("[data-select-group]")) {
    const group = state.inboxGroups.get(e.target.dataset.selectGroup);
    for (const id of group?.resolvableIds || []) {
      if (e.target.checked) selectedActions.add(id);
      else selectedActions.delete(id);
    }
    render();
  }
  if (e.target.id === "confirm-overlap") updateCreateSubmit();
});
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.hasAttribute("data-shadow-run")) {
    await api("/api/shadow-analysis/run", {});
    toast("Shadow analysis queued. No workspace action will execute.");
    return;
  }
  if (b.dataset.view) {
    view = b.dataset.view;
    inboxLimit = 24;
    render();
  }
  if (b.dataset.filter) {
    filter = b.dataset.filter;
    await loadWork(true);
    render();
  }
  if (b.dataset.inboxFilter) {
    inboxFilter = b.dataset.inboxFilter;
    inboxLimit = 24;
    render();
  }
  if (b.hasAttribute("data-show-all")) {
    filter = "all";
    await loadWork(true);
    render();
  }
  if (b.dataset.showEvidence) {
    if (expandedBriefingEvidence.has(b.dataset.showEvidence))
      expandedBriefingEvidence.delete(b.dataset.showEvidence);
    else expandedBriefingEvidence.add(b.dataset.showEvidence);
    const evidence = document.querySelector(
      `[data-evidence-for="${CSS.escape(b.dataset.showEvidence)}"]`,
    );
    if (evidence) {
      evidence.hidden = !evidence.hidden;
      b.textContent = evidence.hidden ? b.dataset.evidenceLabel : "Hide evidence";
      b.setAttribute("aria-expanded", String(!evidence.hidden));
      b.setAttribute(
        "aria-label",
        `${evidence.hidden ? "Show" : "Hide"} evidence for this briefing item`,
      );
    }
  }
  if (b.dataset.briefingFeedback)
    await perform(b, async () => {
      await api("/api/briefing/feedback", {
        recommendationId: b.dataset.recommendation,
        evidenceRevision: b.dataset.revision,
        taskKey: b.dataset.briefingTask || null,
        rating: b.dataset.briefingFeedback,
      });
      toast("Recommendation feedback recorded.");
    });
  if (b.hasAttribute("data-briefing-refresh"))
    await perform(b, async () => {
      await api("/api/refresh", {});
      toast("Astra refreshed the latest source status.");
    });
  if (b.dataset.briefingWatch)
    await perform(b, async () => {
      await api("/api/watch", { key: b.dataset.briefingWatch, value: true });
      toast("Astra will keep this work visible for its next update.");
    });
  if (b.dataset.applyRecommendation) {
    if (
      /^archive this task/i.test(b.textContent || "") &&
      !confirm("Archive this inactive task? It can be restored in Codex if needed.")
    )
      return;
    await perform(b, async () => {
      const result = await api("/api/briefing/apply", {
        requestId: crypto.randomUUID(),
        recommendationId: b.dataset.applyRecommendation,
        evidenceRevision: b.dataset.revision,
        taskKey: b.dataset.briefingTask || null,
      });
      if (result.status === "decision-needed" && result.actionId) {
        toast(result.summary);
        await openAction(result.actionId);
      } else toast(result.summary || "Recommendation applied.");
    });
  }
  if (b.dataset.task) await openTask(b.dataset.task);
  if (b.dataset.watch) {
    const t = state.tasks.find((t) => t.key === b.dataset.watch);
    await perform(b, () =>
      api("/api/work-items/" + encodeURIComponent(t.key) + "/watch", {
        value: !t.watched,
      }),
    );
  }
  if (b.dataset.action) await openAction(b.dataset.action);
  if (b.dataset.resolve)
    await perform(b, async () => {
      await api("/api/actions/resolve", { id: b.dataset.resolve });
      selectedActions.delete(b.dataset.resolve);
      $("#panel").hidden = true;
      panel = null;
    });
  if (b.dataset.expiredApproval)
    await perform(b, async () => {
      const approved = b.dataset.expiredDecision === "accept";
      await api("/api/approval/expired-decision", {
        id: b.dataset.expiredApproval,
        action: b.dataset.expiredDecision,
        requestId: crypto.randomUUID(),
      });
      selectedActions.delete(b.dataset.expiredApproval);
      $("#panel").hidden = true;
      panel = null;
      toast(
        approved
          ? "Approval sent to the agent for this exact request."
          : "Request declined.",
      );
    });
  if (b.dataset.pause)
    await perform(b, async () => {
      await api("/api/pause", {
        key: b.dataset.pause,
        requestId: crypto.randomUUID(),
      });
      toast("Pause requested.");
    });
  if (b.dataset.continue)
    await perform(b, async () => {
      await api("/api/continue", {
        key: b.dataset.continue,
        requestId: crypto.randomUUID(),
      });
      toast("Task continued. Any new decision will appear here.");
    });
  if (b.dataset.stop)
    await perform(b, async () => {
      await api("/api/send", {
        key: b.dataset.stop,
        prompt:
          "Do not continue the current approach or make any changes. The owner disagrees with this direction. Stop at this safe checkpoint and wait for a new owner instruction.",
        requestId: crypto.randomUUID(),
      });
      toast("The agent was told not to continue and to wait for your direction.");
    });
  if (
    b.dataset.archive &&
    confirm(
      "Archive this task? It will leave the active workspace but can be restored in Codex.",
    )
  )
    await perform(b, async () => {
      await api("/api/archive", {
        key: b.dataset.archive,
        requestId: crypto.randomUUID(),
      });
      $("#panel").hidden = true;
      panel = null;
      detail = null;
      await refresh();
      toast("Task archived.");
    });
  if (b.dataset.proposalKey)
    await perform(b, async () => {
      await api("/api/send", {
        key: b.dataset.proposalKey,
        prompt: b.dataset.proposalPrompt,
        requestId: crypto.randomUUID(),
      });
      toast("Instruction accepted by Codex.");
    });
  if (b.dataset.host) openMachines(b.dataset.host);
  if (b.dataset.retryHost)
    await perform(b, async () => {
      await api("/api/hosts/refresh", { hostId: b.dataset.retryHost });
      await refresh();
      openMachines(b.dataset.retryHost);
    });
  if (b.hasAttribute("data-focus-compose")) {
    $("#send-input")?.focus();
    $("#send-input")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
});
await refresh();
stream = new EventSource("/api/events");
stream.addEventListener("change", () => void refresh());
stream.addEventListener("invalidate", (event) => {
  void (async () => {
    try {
      const pages = JSON.parse(event.data || "{}").pages || ["work", "runtime"];
      const work = pages.includes("work") && (view === "overview" || !!detail),
        meta =
          (pages.includes("runtime") && view === "runtime") ||
          (pages.includes("inbox") && view === "inbox");
      await Promise.all([
        work ? loadWork(true) : Promise.resolve(),
        meta ? refreshMeta() : Promise.resolve(),
      ]);
      renderIfChanged();
    } catch {}
  })();
});
stream.onerror = () => {
  $("#connection").textContent = "Reconnecting";
  $("#connection").classList.add("stale");
};
setInterval(() => void refresh(), 15000);
