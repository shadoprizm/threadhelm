import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  BriefingFeedbackRating,
  Task,
  WorkItem,
  WorkSourceRef,
  WorkStatus,
} from "./types.js";
import type { SourceObservation } from "./adapters.js";

export interface WorkQuery {
  source?: string;
  host?: string;
  status?: string;
  kind?: string;
  provider?: string;
  model?: string;
  locality?: string;
  search?: string;
  watched?: boolean;
  limit?: number;
  cursor?: string;
}
const codexCapabilities = {
  detail: true,
  deepLink: true,
  send: true,
  steer: true,
  pause: true,
  approve: true,
  git: true,
};
function codexStatus(task: Task): WorkStatus {
  if (task.status === "running") return "active";
  if (task.status === "failed" || task.turnStatus === "failed") return "failed";
  if (task.status === "paused" || task.turnStatus === "interrupted")
    return "waiting";
  // An in-progress projection without a live writer lock is recoverable work that
  // needs inspection, not proof that an agent is currently running.
  if (task.turnStatus === "inProgress") return "waiting";
  if (task.turnStatus === "completed") return "completed";
  if (task.status === "idle") return "idle";
  return "unknown";
}
function codexWork(task: Task): WorkItem {
  const source: WorkSourceRef = {
    adapter: "codex",
    sourceId: `codex-${task.hostId}`,
    hostId: task.hostId,
    nativeId: task.id,
    deepLink: `codex://threads/${encodeURIComponent(task.id)}`,
    capabilities: codexCapabilities,
  };
  return {
    key: task.key,
    id: task.key,
    kind: "agent-task",
    title: task.title,
    status: codexStatus(task),
    statusConfidence: "authoritative",
    updatedAt: task.updatedAt,
    observedAt: task.observedAt,
    archived: false,
    pinned: false,
    watched: !!task.watched,
    latestExcerpt: task.latest?.text?.slice(0, 4000),
    sourceRefs: [source],
    execution: {
      host: task.hostId,
      requestedModel: task.model,
      locality: "unknown",
    },
    hostId: task.hostId,
    cwd: task.cwd,
    projectId: task.projectId,
    branch: task.branch,
    latest: task.latest,
    messages: [],
    model: task.model,
    error: task.error,
    managed: task.managed,
    owned: task.owned,
    turnId: task.turnId,
    turnStatus: task.turnStatus,
  };
}
function parse<T>(value: any, fallback: T): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}
function storedTask(task: Task): Task {
  return {
    ...task,
    latest: task.latest
      ? {
          ...task.latest,
          text: task.latest.text.slice(0, 4000),
          output: task.latest.output?.slice(0, 4000),
        }
      : undefined,
    messages: [],
  };
}
function storedAction(row: any) {
  return row
    ? {
        ...row,
        payload: row.payload ? parse(row.payload, null) : null,
      }
    : undefined;
}

export class Store {
  db: DatabaseSync;
  private backupMigrations: boolean;
  constructor(private path: string) {
    this.backupMigrations = path !== ":memory:" && existsSync(path);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
 CREATE TABLE IF NOT EXISTS tasks(key TEXT PRIMARY KEY, payload TEXT NOT NULL, watched INTEGER NOT NULL DEFAULT 0, managed INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, task_key TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, fingerprint TEXT UNIQUE, payload TEXT);
 CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, task_key TEXT, kind TEXT, body TEXT, status TEXT, result TEXT, created_at INTEGER, updated_at INTEGER);
 CREATE TABLE IF NOT EXISTS chat(id TEXT PRIMARY KEY, role TEXT, body TEXT, created_at INTEGER);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS work_items(id TEXT PRIMARY KEY,kind TEXT NOT NULL,status TEXT NOT NULL,status_confidence TEXT NOT NULL,title TEXT NOT NULL,updated_at INTEGER NOT NULL,observed_at INTEGER NOT NULL,watched INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,provider TEXT,requested_model TEXT,resolved_model TEXT,locality TEXT NOT NULL,host_id TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS work_sources(adapter TEXT NOT NULL,source_id TEXT NOT NULL,host_id TEXT NOT NULL,native_id TEXT NOT NULL,work_id TEXT NOT NULL,profile TEXT,agent TEXT,deep_link TEXT,capabilities TEXT NOT NULL,payload TEXT NOT NULL,observed_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,latest_excerpt TEXT,PRIMARY KEY(adapter,source_id,native_id));
 CREATE INDEX IF NOT EXISTS work_sources_work_idx ON work_sources(work_id);
 CREATE INDEX IF NOT EXISTS work_sources_source_idx ON work_sources(source_id,observed_at);
 CREATE TABLE IF NOT EXISTS work_correlations(correlation TEXT PRIMARY KEY,work_id TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS source_cursors(source_id TEXT PRIMARY KEY,cursor TEXT,updated_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS work_items_recent_idx ON work_items(updated_at DESC,id);
 `);
    this.runMigrations();
    this.captureDecisionBaseline();
  }
  private backupBeforeMigration(version: number) {
    if (!this.backupMigrations) return;
    const directory = join(dirname(this.path), "migration-backups"),
      stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-"),
      destination = join(
        directory,
        `${basename(this.path)}.before-v${version}-${stamp}-${randomUUID().slice(0, 8)}.sqlite`,
      );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db.exec("PRAGMA wal_checkpoint(FULL)");
    this.db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
    chmodSync(destination, 0o600);
  }
  private applyMigration(version: number, apply: () => void) {
    if (
      this.db
        .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
        .get(version)
    )
      return;
    this.backupBeforeMigration(version);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      apply();
      this.db
        .prepare(
          "INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
        )
        .run(version, Date.now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private runMigrations() {
    this.applyMigration(1, () => {
      const records = this.db.prepare("SELECT * FROM tasks").all() as any[];
      for (const row of records) {
        const task = {
          ...parse<Task>(row.payload, {} as Task),
          watched: !!row.watched,
          managed: !!row.managed,
        };
        if (task.key)
          this.writeSource({
            item: codexWork(task),
            source: codexWork(task).sourceRefs[0],
            correlations: [],
            native: { taskId: task.id },
          });
      }
    });
    this.applyMigration(2, () => {
      const records = this.db
          .prepare("SELECT key,payload FROM tasks")
          .all() as any[],
        update = this.db.prepare("UPDATE tasks SET payload=? WHERE key=?");
      for (const row of records) {
        const task = parse<Task>(row.payload, {} as Task);
        if (task.key) update.run(JSON.stringify(storedTask(task)), row.key);
      }
    });
    this.applyMigration(3, () => {
      const columns = this.db
        .prepare("PRAGMA table_info(commands)")
        .all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === "actor"))
        this.db.exec(
          "ALTER TABLE commands ADD COLUMN actor TEXT NOT NULL DEFAULT 'owner' CHECK(actor IN ('owner','coordinator','autopilot'))",
        );
    });
    this.applyMigration(4, () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS coordinator_proposals(
          id TEXT PRIMARY KEY,
          evidence_revision TEXT NOT NULL,
          model_action_id TEXT NOT NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','stale','executed','dismissed')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(evidence_revision,model_action_id)
        );
        CREATE INDEX IF NOT EXISTS coordinator_proposals_status_idx ON coordinator_proposals(status,created_at DESC);
      `);
    });
    this.applyMigration(5, () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS briefing_feedback(
          id TEXT PRIMARY KEY,
          recommendation_id TEXT NOT NULL,
          evidence_revision TEXT NOT NULL,
          task_key TEXT,
          rating TEXT NOT NULL CHECK(rating IN ('useful','wrong','stale')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(recommendation_id,evidence_revision)
        );
        CREATE INDEX IF NOT EXISTS briefing_feedback_updated_idx ON briefing_feedback(updated_at DESC);
      `);
    });
    this.applyMigration(6, () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS shadow_analyses(
          id TEXT PRIMARY KEY,
          task_key TEXT NOT NULL,
          evidence_revision TEXT NOT NULL,
          route TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
          category TEXT,
          title TEXT,
          recommendation TEXT,
          rationale TEXT,
          risk TEXT,
          confidence TEXT,
          next_checkpoint TEXT,
          input_chars INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER,
          output_tokens INTEGER,
          latency_ms INTEGER,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(task_key,evidence_revision)
        );
        CREATE INDEX IF NOT EXISTS shadow_analyses_status_idx ON shadow_analyses(status,created_at DESC);
        CREATE INDEX IF NOT EXISTS shadow_analyses_daily_idx ON shadow_analyses(created_at,status);
      `);
    });
    this.applyMigration(7, () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS applied_recommendations(
          recommendation_id TEXT NOT NULL,
          evidence_revision TEXT NOT NULL,
          applied_at INTEGER NOT NULL,
          PRIMARY KEY(recommendation_id,evidence_revision)
        );
      `);
    });
  }
  private captureDecisionBaseline() {
    const key = "baseline.release0.decision.v1";
    if (this.db.prepare("SELECT 1 FROM settings WHERE key=?").get(key)) return;
    const records = this.db
        .prepare(
          "SELECT status,created_at,updated_at FROM actions WHERE kind='approval'",
        )
        .all() as Array<{
        status: string;
        created_at: number;
        updated_at: number;
      }>,
      durations = records
        .filter(
          (record) =>
            ["responding", "resolved"].includes(record.status) &&
            record.updated_at >= record.created_at,
        )
        .map((record) => record.updated_at - record.created_at)
        .sort((a, b) => a - b),
      percentile = (ratio: number) =>
        durations.length
          ? durations[
              Math.min(
                durations.length - 1,
                Math.floor(durations.length * ratio),
              )
            ]
          : null,
      baseline = {
        capturedAt: Date.now(),
        total: records.length,
        decided: durations.length,
        open: records.filter((record) => record.status === "open").length,
        expired: records.filter((record) => record.status === "expired").length,
        medianMs: percentile(0.5),
        p90Ms: percentile(0.9),
      };
    this.db
      .prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)")
      .run(key, JSON.stringify(baseline));
  }
  decisionBaseline() {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get("baseline.release0.decision.v1") as any;
    return parse(row?.value, null);
  }
  saveCoordinatorProposal(
    id: string,
    evidenceRevision: string,
    modelActionId: string,
    action: any,
  ) {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO coordinator_proposals(id,evidence_revision,model_action_id,action,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        evidenceRevision,
        modelActionId,
        JSON.stringify(action),
        "proposed",
        now,
        now,
      );
    return this.coordinatorProposal(id);
  }
  coordinatorProposal(id: string, evidenceRevision?: string) {
    const row = this.db
      .prepare("SELECT * FROM coordinator_proposals WHERE id=?")
      .get(id) as any;
    if (
      !row ||
      (evidenceRevision &&
        (row.evidence_revision !== evidenceRevision ||
          row.status !== "proposed"))
    )
      return undefined;
    return { ...row, action: parse(row.action, null) };
  }
  setCoordinatorProposalStatus(id: string, status: "executed" | "stale") {
    this.db
      .prepare("UPDATE coordinator_proposals SET status=?,updated_at=? WHERE id=?")
      .run(status, Date.now(), id);
  }
  staleCoordinatorProposalsExcept(evidenceRevision: string) {
    this.db
      .prepare(
        "UPDATE coordinator_proposals SET status='stale',updated_at=? WHERE status='proposed' AND evidence_revision<>?",
      )
      .run(Date.now(), evidenceRevision);
  }
  coordinatorProposals() {
    return this.db
      .prepare(
        "SELECT * FROM coordinator_proposals ORDER BY created_at DESC LIMIT 250",
      )
      .all()
      .map((row: any) => ({ ...row, action: parse(row.action, null) }));
  }
  saveBriefingFeedback(
    recommendationId: string,
    evidenceRevision: string,
    taskKey: string | null,
    rating: BriefingFeedbackRating,
  ) {
    const now = Date.now(),
      id = `${recommendationId}:${evidenceRevision}`;
    this.db
      .prepare(
        "INSERT INTO briefing_feedback(id,recommendation_id,evidence_revision,task_key,rating,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(recommendation_id,evidence_revision) DO UPDATE SET rating=excluded.rating,task_key=excluded.task_key,updated_at=excluded.updated_at",
      )
      .run(
        id,
        recommendationId,
        evidenceRevision,
        taskKey,
        rating,
        now,
        now,
      );
    return this.db
      .prepare(
        "SELECT * FROM briefing_feedback WHERE recommendation_id=? AND evidence_revision=?",
      )
      .get(recommendationId, evidenceRevision) as any;
  }
  briefingFeedback(): any[] {
    return this.db
      .prepare(
        "SELECT * FROM briefing_feedback ORDER BY updated_at DESC LIMIT 1000",
      )
      .all() as any[];
  }
  reserveShadowAnalysis(
    taskKey: string,
    evidenceRevision: string,
    route: string,
    model: string,
    inputChars: number,
    dailyCallLimit: number,
    observableTokenLimit: number,
    now = Date.now(),
  ) {
    const day = Date.UTC(
        new Date(now).getUTCFullYear(),
        new Date(now).getUTCMonth(),
        new Date(now).getUTCDate(),
      ),
      id = `shadow-${createHash("sha256")
        .update(`${taskKey}\0${evidenceRevision}`)
        .digest("hex")}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.db
          .prepare(
            "SELECT 1 FROM shadow_analyses WHERE task_key=? AND evidence_revision=?",
          )
          .get(taskKey, evidenceRevision)
      ) {
        this.db.exec("COMMIT");
        return { accepted: false, reason: "already-analyzed", id };
      }
      const usage = this.db
        .prepare(
          `SELECT COUNT(*) calls,
             COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) observable_tokens
           FROM shadow_analyses WHERE created_at>=?`,
        )
        .get(day) as any;
      if (Number(usage.calls) >= dailyCallLimit) {
        this.db.exec("COMMIT");
        return { accepted: false, reason: "daily-call-limit", id };
      }
      if (Number(usage.observable_tokens) >= observableTokenLimit) {
        this.db.exec("COMMIT");
        return { accepted: false, reason: "observable-token-limit", id };
      }
      this.db
        .prepare(
          `INSERT INTO shadow_analyses(
             id,task_key,evidence_revision,route,model,status,input_chars,created_at,updated_at
           ) VALUES(?,?,?,?,?,'running',?,?,?)`,
        )
        .run(id, taskKey, evidenceRevision, route, model, inputChars, now, now);
      this.db.exec("COMMIT");
      return { accepted: true, reason: "reserved", id };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  finishShadowAnalysis(id: string, result: any, now = Date.now()) {
    this.db
      .prepare(
        `UPDATE shadow_analyses SET status='succeeded',category=?,title=?,recommendation=?,
         rationale=?,risk=?,confidence=?,next_checkpoint=?,input_tokens=?,output_tokens=?,
         latency_ms=?,error=NULL,updated_at=? WHERE id=? AND status='running'`,
      )
      .run(
        result.category,
        result.title,
        result.recommendation,
        result.rationale,
        result.risk,
        result.confidence,
        result.nextCheckpoint,
        result.inputTokens ?? null,
        result.outputTokens ?? null,
        result.latencyMs ?? null,
        now,
        id,
      );
    return this.shadowAnalysis(id);
  }
  failShadowAnalysis(id: string, error: string, latencyMs: number, now = Date.now()) {
    this.db
      .prepare(
        "UPDATE shadow_analyses SET status='failed',error=?,latency_ms=?,updated_at=? WHERE id=? AND status='running'",
      )
      .run(error.slice(0, 1000), latencyMs, now, id);
    return this.shadowAnalysis(id);
  }
  shadowAnalysis(id: string) {
    return this.db.prepare("SELECT * FROM shadow_analyses WHERE id=?").get(id) as any;
  }
  shadowAnalyses(limit = 1000) {
    return this.db
      .prepare("SELECT * FROM shadow_analyses ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(5000, limit))) as any[];
  }
  unappliedShadowAnalyses(limit = 1000) {
    return this.db
      .prepare(
        `SELECT analysis.* FROM shadow_analyses analysis
         WHERE NOT EXISTS(
           SELECT 1 FROM applied_recommendations applied
           WHERE applied.recommendation_id=analysis.id
           AND applied.evidence_revision=analysis.evidence_revision
         ) ORDER BY analysis.created_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(5000, limit))) as any[];
  }
  shadowAnalysisApplied(id: string, evidenceRevision: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM applied_recommendations WHERE recommendation_id=? AND evidence_revision=?",
      )
      .get(id, evidenceRevision);
  }
  applyShadowAnalysis(id: string, evidenceRevision: string) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO applied_recommendations(recommendation_id,evidence_revision,applied_at) VALUES(?,?,?)",
      )
      .run(id, evidenceRevision, Date.now());
  }
  shadowMetrics(now = Date.now()) {
    const date = new Date(now),
      day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
      today = this.db
        .prepare(
          `SELECT COUNT(*) calls,
             SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) succeeded,
             SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
             COALESCE(SUM(input_chars),0) input_chars,
             COALESCE(SUM(input_tokens),0) input_tokens,
             COALESCE(SUM(output_tokens),0) output_tokens,
             SUM(CASE WHEN input_tokens IS NOT NULL OR output_tokens IS NOT NULL THEN 1 ELSE 0 END) usage_reported
           FROM shadow_analyses WHERE created_at>=?`,
        )
        .get(day) as any,
      total = this.db
        .prepare(
          `SELECT COUNT(*) analyses,
             SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) succeeded,
             SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
             MIN(created_at) started_at
           FROM shadow_analyses`,
        )
        .get() as any,
      ratings = this.db
        .prepare(
          `SELECT rating,COUNT(*) count FROM briefing_feedback
           WHERE recommendation_id LIKE 'shadow-%' GROUP BY rating`,
        )
        .all() as any[];
    return {
      today: {
        calls: Number(today.calls || 0),
        succeeded: Number(today.succeeded || 0),
        failed: Number(today.failed || 0),
        inputChars: Number(today.input_chars || 0),
        inputTokens: Number(today.input_tokens || 0),
        outputTokens: Number(today.output_tokens || 0),
        usageReported: Number(today.usage_reported || 0),
      },
      total: {
        analyses: Number(total.analyses || 0),
        succeeded: Number(total.succeeded || 0),
        failed: Number(total.failed || 0),
        startedAt: total.started_at == null ? null : Number(total.started_at),
        feedback: Object.fromEntries(
          ratings.map((row) => [String(row.rating), Number(row.count)]),
        ),
      },
    };
  }
  openActions(limit = 1000) {
    return this.db
      .prepare(
        "SELECT * FROM actions WHERE status NOT IN ('resolved','reissued','approved','declined') ORDER BY created_at DESC LIMIT ?",
      )
      .all(Math.max(1, Math.min(5000, limit)))
      .map(storedAction);
  }
  briefingCandidates(limit = 250) {
    const rows = this.db
      .prepare(
        `SELECT payload,watched FROM work_items
         WHERE (archived=0 OR pinned=1)
           AND (watched=1 OR status IN ('active','recent','waiting','failed','offline'))
         ORDER BY CASE status
           WHEN 'failed' THEN 1 WHEN 'waiting' THEN 2 WHEN 'active' THEN 3
           WHEN 'recent' THEN 4 WHEN 'offline' THEN 5 ELSE 6 END,
           watched DESC,updated_at DESC,id
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(1000, limit))) as any[];
    return rows.map((row) => ({
      ...parse<WorkItem>(row.payload, {} as WorkItem),
      watched: !!row.watched,
    }));
  }
  upsert(t: Task) {
    const compact = storedTask(t);
    this.db
      .prepare(
        "INSERT INTO tasks(key,payload) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
      )
      .run(t.key, JSON.stringify(compact));
    const saved = this.task(t.key)!;
    this.writeSource({
      item: codexWork(saved),
      source: codexWork(saved).sourceRefs[0],
      correlations: [],
      native: { taskId: t.id },
    });
  }
  tasks(): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks")
      .all()
      .map((r: any) => ({
        ...JSON.parse(r.payload),
        watched: !!r.watched,
        managed: !!r.managed,
      }));
  }
  task(key: string) {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE key=?")
      .get(key) as any;
    return row
      ? {
          ...JSON.parse(row.payload),
          watched: !!row.watched,
          managed: !!row.managed,
        }
      : undefined;
  }
  watch(key: string, value: boolean) {
    this.db.prepare("UPDATE tasks SET watched=? WHERE key=?").run(+value, key);
    this.db
      .prepare("UPDATE work_items SET watched=? WHERE id=?")
      .run(+value, key);
    const current = this.workItem(key);
    if (current) {
      current.watched = value;
      this.db
        .prepare("UPDATE work_items SET payload=? WHERE id=?")
        .run(JSON.stringify(current), key);
    }
  }
  manage(key: string) {
    this.db
      .prepare("UPDATE tasks SET managed=1,watched=1 WHERE key=?")
      .run(key);
    this.db.prepare("UPDATE work_items SET watched=1 WHERE id=?").run(key);
    const current = this.workItem(key);
    if (current) {
      current.watched = true;
      current.managed = true;
      this.db
        .prepare("UPDATE work_items SET payload=? WHERE id=?")
        .run(JSON.stringify(current), key);
    }
  }
  removeTask(key: string) {
    const task = this.task(key);
    if (!task) return false;
    const rows = this.db
        .prepare(
          "SELECT DISTINCT work_id FROM work_sources WHERE adapter='codex' AND source_id=? AND native_id=?",
        )
        .all(`codex-${task.hostId}`, task.id) as any[],
      affected = rows.map((row) => String(row.work_id));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM tasks WHERE key=?").run(key);
      this.db
        .prepare(
          "DELETE FROM work_sources WHERE adapter='codex' AND source_id=? AND native_id=?",
        )
        .run(`codex-${task.hostId}`, task.id);
      this.db
        .prepare(
          "UPDATE actions SET status='resolved',updated_at=? WHERE task_key=? AND status<>'resolved'",
        )
        .run(Date.now(), key);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const id of affected) this.rebuild(id);
    return true;
  }
  migrate() {
    this.runMigrations();
  }
  private workId(observation: SourceObservation) {
    const current = this.db
      .prepare(
        "SELECT work_id FROM work_sources WHERE adapter=? AND source_id=? AND native_id=?",
      )
      .get(
        observation.source.adapter,
        observation.source.sourceId,
        observation.source.nativeId,
      ) as any;
    if (current?.work_id) return String(current.work_id);
    const linked = [
      ...new Set(
        observation.correlations
          .map(
            (value) =>
              (
                this.db
                  .prepare(
                    "SELECT work_id FROM work_correlations WHERE correlation=?",
                  )
                  .get(value) as any
              )?.work_id,
          )
          .filter(Boolean),
      ),
    ];
    return linked.length === 1 ? String(linked[0]) : observation.item.id;
  }
  private writeSource(observation: SourceObservation, rebuild = true) {
    const workId = this.workId(observation),
      source = observation.source,
      item = {
        ...observation.item,
        key: workId,
        id: workId,
        sourceRefs: [source],
      };
    this.db
      .prepare(
        `INSERT INTO work_sources(adapter,source_id,host_id,native_id,work_id,profile,agent,deep_link,capabilities,payload,observed_at,updated_at,archived,pinned,latest_excerpt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(adapter,source_id,native_id) DO UPDATE SET host_id=excluded.host_id,work_id=excluded.work_id,profile=excluded.profile,agent=excluded.agent,deep_link=excluded.deep_link,capabilities=excluded.capabilities,payload=excluded.payload,observed_at=excluded.observed_at,updated_at=excluded.updated_at,archived=excluded.archived,pinned=excluded.pinned,latest_excerpt=excluded.latest_excerpt`,
      )
      .run(
        source.adapter,
        source.sourceId,
        source.hostId,
        source.nativeId,
        workId,
        source.profile || null,
        source.agent || null,
        source.deepLink || null,
        JSON.stringify(source.capabilities),
        JSON.stringify({ ...observation, native: observation.native, item }),
        item.observedAt,
        item.updatedAt,
        +item.archived,
        +item.pinned,
        item.latestExcerpt?.slice(0, 4000) || null,
      );
    for (const value of observation.correlations)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO work_correlations(correlation,work_id,created_at) VALUES(?,?,?)",
        )
        .run(value, workId, Date.now());
    if (rebuild) this.rebuild(workId);
    return workId;
  }
  upsertSource(observation: SourceObservation) {
    return this.writeSource(observation);
  }
  private rebuild(workId: string) {
    const sourceRows = this.db
      .prepare(
        "SELECT * FROM work_sources WHERE work_id=? ORDER BY updated_at DESC",
      )
      .all(workId) as any[];
    if (!sourceRows.length) {
      this.db.prepare("DELETE FROM work_items WHERE id=?").run(workId);
      return;
    }
    const observations = sourceRows
        .map((row) =>
          parse<SourceObservation>(row.payload, {} as SourceObservation),
        )
        .filter((value) => value.item),
      previous = this.db
        .prepare("SELECT watched FROM work_items WHERE id=?")
        .get(workId) as any,
      newest = observations[0].item;
    const sourceRefs = observations.map((value) => value.source),
      statuses = observations.map((value) => value.item.status),
      status =
        (
          [
            "failed",
            "waiting",
            "active",
            "recent",
            "completed",
            "idle",
            "offline",
            "unknown",
          ] as WorkStatus[]
        ).find((value) => statuses.includes(value)) || "unknown",
      updatedAt = Math.max(
        ...observations.map((value) => value.item.updatedAt),
      ),
      observedAt = Math.max(
        ...observations.map((value) => value.item.observedAt),
      ),
      allArchived = observations.every((value) => value.item.archived),
      anyPinned = observations.some((value) => value.item.pinned);
    const aggregate: WorkItem = {
      ...newest,
      key: workId,
      id: workId,
      status,
      statusConfidence: observations.some(
        (value) =>
          value.item.status === status &&
          value.item.statusConfidence === "authoritative",
      )
        ? "authoritative"
        : "heuristic",
      updatedAt,
      observedAt,
      archived: allArchived,
      pinned: anyPinned,
      watched: !!previous?.watched || newest.watched,
      sourceRefs,
      latestExcerpt: newest.latestExcerpt?.slice(0, 4000),
    };
    this.db
      .prepare(
        `INSERT INTO work_items(id,kind,status,status_confidence,title,updated_at,observed_at,watched,archived,pinned,provider,requested_model,resolved_model,locality,host_id,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,status=excluded.status,status_confidence=excluded.status_confidence,title=excluded.title,updated_at=excluded.updated_at,observed_at=excluded.observed_at,watched=work_items.watched,archived=excluded.archived,pinned=excluded.pinned,provider=excluded.provider,requested_model=excluded.requested_model,resolved_model=excluded.resolved_model,locality=excluded.locality,host_id=excluded.host_id,payload=excluded.payload`,
      )
      .run(
        workId,
        aggregate.kind,
        aggregate.status,
        aggregate.statusConfidence,
        aggregate.title,
        aggregate.updatedAt,
        aggregate.observedAt,
        +aggregate.watched,
        +aggregate.archived,
        +aggregate.pinned,
        aggregate.execution.provider || null,
        aggregate.execution.requestedModel || null,
        aggregate.execution.resolvedModel || null,
        aggregate.execution.locality,
        aggregate.hostId,
        JSON.stringify(aggregate),
      );
  }
  pruneSource(sourceId: string, seen: string[]) {
    const rows = this.db
        .prepare(
          "SELECT adapter,work_id,native_id FROM work_sources WHERE source_id=?",
        )
        .all(sourceId) as any[],
      keep = new Set(seen),
      affected = new Set<string>();
    for (const row of rows)
      if (!keep.has(String(row.native_id))) {
        this.reconcileStateAction(
          `state:${row.adapter}:${sourceId}:${row.native_id}:`,
          null,
        );
        this.db
          .prepare("DELETE FROM work_sources WHERE source_id=? AND native_id=?")
          .run(sourceId, row.native_id);
        affected.add(String(row.work_id));
      }
    for (const id of affected) this.rebuild(id);
  }
  sourceObservation(adapter: string, sourceId: string, nativeId: string) {
    const row = this.db
      .prepare(
        "SELECT payload FROM work_sources WHERE adapter=? AND source_id=? AND native_id=?",
      )
      .get(adapter, sourceId, nativeId) as any;
    return row
      ? parse<SourceObservation>(row.payload, {} as SourceObservation)
      : undefined;
  }
  workForSession(sourceId: string, sessionKey: string) {
    for (const row of this.db
      .prepare("SELECT work_id,payload FROM work_sources WHERE source_id=?")
      .all(sourceId) as any[]) {
      const observation = parse<SourceObservation>(
        row.payload,
        {} as SourceObservation,
      );
      if (
        observation.native?.sessionKey === sessionKey ||
        observation.source?.nativeId === sessionKey
      )
        return String(row.work_id);
    }
    return null;
  }
  workSources(id: string): SourceObservation[] {
    return (
      this.db
        .prepare(
          "SELECT payload FROM work_sources WHERE work_id=? ORDER BY updated_at DESC",
        )
        .all(id) as any[]
    ).map((row) =>
      parse<SourceObservation>(row.payload, {} as SourceObservation),
    );
  }
  workItem(id: string): WorkItem | undefined {
    const row = this.db
      .prepare("SELECT payload,watched FROM work_items WHERE id=?")
      .get(id) as any;
    if (!row) return;
    return {
      ...parse<WorkItem>(row.payload, {} as WorkItem),
      watched: !!row.watched,
    };
  }
  workItems(query: WorkQuery = {}) {
    this.runMigrations();
    const where = ["(w.archived=0 OR w.pinned=1)"],
      params: any[] = [];
    if (query.watched) where.push("w.watched=1");
    if (query.host) {
      where.push(
        "EXISTS (SELECT 1 FROM work_sources hs WHERE hs.work_id=w.id AND hs.host_id=?)",
      );
      params.push(query.host);
    }
    if (query.status) {
      where.push("w.status=?");
      params.push(query.status);
    }
    if (query.kind) {
      where.push("w.kind=?");
      params.push(query.kind);
    }
    if (query.provider) {
      where.push("w.provider=?");
      params.push(query.provider);
    }
    if (query.locality) {
      where.push("w.locality=?");
      params.push(query.locality);
    }
    if (query.model) {
      where.push("(w.requested_model LIKE ? OR w.resolved_model LIKE ?)");
      params.push(`%${query.model}%`, `%${query.model}%`);
    }
    if (query.source) {
      where.push(
        "EXISTS (SELECT 1 FROM work_sources s WHERE s.work_id=w.id AND (s.adapter=? OR s.source_id=?))",
      );
      params.push(query.source, query.source);
    }
    if (query.search) {
      where.push("(w.title LIKE ? OR w.payload LIKE ?)");
      params.push(`%${query.search}%`, `%${query.search}%`);
    }
    const limit = Math.max(1, Math.min(100, query.limit || 50)),
      offset = Math.max(0, Number(query.cursor) || 0),
      sql = `SELECT payload,watched FROM work_items w WHERE ${where.join(" AND ")} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`,
      records = this.db.prepare(sql).all(...params, limit + 1, offset) as any[],
      more = records.length > limit,
      items = records.slice(0, limit).map((row) => ({
        ...parse<WorkItem>(row.payload, {} as WorkItem),
        watched: !!row.watched,
      }));
    return { items, nextCursor: more ? String(offset + limit) : null };
  }
  workSummary() {
    this.runMigrations();
    const rows = this.db
      .prepare(
        "SELECT status,kind,locality,COUNT(*) count FROM work_items WHERE archived=0 OR pinned=1 GROUP BY status,kind,locality",
      )
      .all() as any[];
    const total = rows.reduce((sum, row) => sum + Number(row.count), 0),
      byStatus: Record<string, number> = {},
      byKind: Record<string, number> = {},
      byLocality: Record<string, number> = {};
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] || 0) + Number(row.count);
      byKind[row.kind] = (byKind[row.kind] || 0) + Number(row.count);
      byLocality[row.locality] =
        (byLocality[row.locality] || 0) + Number(row.count);
    }
    const watched = Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) count FROM work_items WHERE watched=1 AND (archived=0 OR pinned=1)",
          )
          .get() as any
      )?.count || 0,
    );
    return { total, watched, byStatus, byKind, byLocality };
  }
  workProviders() {
    return (
      this.db
        .prepare(
          "SELECT provider,locality,COUNT(*) count FROM work_items WHERE provider IS NOT NULL AND provider<>'' AND (archived=0 OR pinned=1) GROUP BY provider,locality ORDER BY provider,locality",
        )
        .all() as any[]
    ).map((row) => ({
      provider: String(row.provider),
      locality: String(row.locality),
      count: Number(row.count),
    }));
  }
  setCursor(sourceId: string, cursor: string | null) {
    this.db
      .prepare(
        "INSERT INTO source_cursors(source_id,cursor,updated_at) VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at",
      )
      .run(sourceId, cursor, Date.now());
  }
  cursor(sourceId: string) {
    return (
      this.db
        .prepare("SELECT cursor FROM source_cursors WHERE source_id=?")
        .get(sourceId) as any
    )?.cursor as string | undefined;
  }
  action(
    kind: string,
    title: string,
    body: string,
    key: string | null,
    fingerprint: string,
    payload?: any,
  ) {
    const id = randomUUID(),
      now = Date.now();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO actions(id,task_key,kind,title,body,created_at,updated_at,fingerprint,payload) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        key,
        kind,
        title,
        body,
        now,
        now,
        fingerprint,
        payload ? JSON.stringify(payload) : null,
      );
    return this.db
      .prepare("SELECT * FROM actions WHERE fingerprint=?")
      .get(fingerprint) as any;
  }
  reconcileStateAction(
    prefix: string,
    current: {
      kind: string;
      title: string;
      body: string;
      key: string;
      fingerprint: string;
      payload?: any;
    } | null,
  ) {
    const stem = prefix.endsWith(":") ? prefix : `${prefix}:`,
      now = Date.now(),
      currentFingerprint = current?.fingerprint || "";
    this.db
      .prepare(
        "UPDATE actions SET status='resolved',updated_at=? WHERE status='open' AND substr(fingerprint,1,?)=? AND fingerprint<>?",
      )
      .run(now, stem.length, stem, currentFingerprint);
    return current
      ? this.action(
          current.kind,
          current.title,
          current.body,
          current.key,
          current.fingerprint,
          { ...(current.payload || {}), stateDerived: true },
        )
      : null;
  }
  actions() {
    return this.db
      .prepare(
        `SELECT * FROM actions
         WHERE id IN (SELECT id FROM actions ORDER BY created_at DESC LIMIT 250)
            OR (kind='approval' AND status IN ('open','responding'))
         ORDER BY created_at DESC`,
      )
      .all()
      .map(storedAction);
  }
  actionById(id: string) {
    return storedAction(
      this.db.prepare("SELECT * FROM actions WHERE id=?").get(id),
    );
  }
  pendingApprovals() {
    return this.db
      .prepare(
        "SELECT * FROM actions WHERE kind='approval' AND status IN ('open','responding') ORDER BY created_at DESC",
      )
      .all()
      .map(storedAction);
  }
  pendingApprovalForTask(key: string) {
    return storedAction(
      this.db
        .prepare(
          "SELECT * FROM actions WHERE task_key=? AND kind='approval' AND status IN ('open','responding') ORDER BY created_at DESC LIMIT 1",
        )
        .get(key),
    );
  }
  resolve(id: string, status = "resolved") {
    this.db
      .prepare("UPDATE actions SET status=?,updated_at=? WHERE id=?")
      .run(status, Date.now(), id);
  }
  resolveMany(ids: string[], status = "resolved") {
    const update = this.db.prepare(
        "UPDATE actions SET status=?,updated_at=? WHERE id=?",
      ),
      now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of [...new Set(ids)]) update.run(status, now, id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  expireApprovals(hostId?: string) {
    this.db
      .prepare(
        "UPDATE actions SET status='expired',updated_at=? WHERE kind='approval' AND status IN ('open','responding')" +
          (hostId ? " AND task_key LIKE ?" : ""),
      )
      .run(...(hostId ? [Date.now(), hostId + ":%"] : [Date.now()]));
  }
  beginCommand(
    id: string,
    key: string,
    kind: string,
    body: any,
    actor: "owner" | "coordinator" | "autopilot" = "owner",
  ) {
    const now = Date.now();
    const changed = this.db
      .prepare(
        "INSERT OR IGNORE INTO commands(id,task_key,kind,body,status,result,created_at,updated_at,actor) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        key,
        kind,
        JSON.stringify(body),
        "sending",
        null,
        now,
        now,
        actor,
      );
    return Number(changed.changes) > 0;
  }
  command(id: string) {
    return this.db.prepare("SELECT * FROM commands WHERE id=?").get(id) as any;
  }
  finishCommand(id: string, status: string, result: any) {
    this.db
      .prepare("UPDATE commands SET status=?,result=?,updated_at=? WHERE id=?")
      .run(status, JSON.stringify(result), Date.now(), id);
  }
  recover() {
    this.db
      .prepare("UPDATE commands SET status='uncertain' WHERE status='sending'")
      .run();
    this.db
      .prepare(
        "UPDATE shadow_analyses SET status='failed',error='Analysis process restarted before completion',updated_at=? WHERE status='running'",
      )
      .run(Date.now());
    this.expireApprovals();
  }
  commands() {
    return this.db
      .prepare("SELECT * FROM commands ORDER BY created_at DESC LIMIT 60")
      .all();
  }
  addChat(role: string, body: any) {
    this.db
      .prepare("INSERT INTO chat VALUES(?,?,?,?)")
      .run(randomUUID(), role, JSON.stringify(body), Date.now());
  }
  chat() {
    return this.db
      .prepare(
        "SELECT * FROM (SELECT * FROM chat ORDER BY created_at DESC LIMIT 40) ORDER BY created_at",
      )
      .all()
      .map((r: any) => ({ ...r, body: JSON.parse(r.body) }));
  }
  close() {
    this.db.close();
  }
}
