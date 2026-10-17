export interface HostConfig {
  id: string;
  name: string;
  ssh?: string;
  codex: string;
  python?: string;
  codexVersions?: string[];
}
export interface Message {
  id: string;
  role: string;
  text: string;
  phase?: string;
  at?: number;
  status?: string;
  exitCode?: number;
  output?: string;
}
export interface Task {
  key: string;
  hostId: string;
  id: string;
  title: string;
  cwd: string;
  projectId?: string;
  branch?: string;
  updatedAt: number;
  observedAt: number;
  turnId?: string;
  turnStatus?: string;
  status: string;
  owned: boolean | null;
  latest?: Message;
  messages: Message[];
  model?: string;
  error?: string;
  managed?: boolean;
  watched?: boolean;
}
export interface Project {
  id: string | null;
  hostId: string;
  name: string;
  roots: string[];
  source: "codex" | "history";
  recencyAt?: number | null;
}
export type WorkKind = "agent-task" | "conversation" | "automation";
export type WorkStatus =
  | "active"
  | "recent"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "offline"
  | "unknown";
export type StatusConfidence = "authoritative" | "heuristic";
export type Locality = "local" | "cloud" | "hybrid" | "unknown";
export type AdapterName =
  | "codex"
  | "claude"
  | "hermes"
  | "openclaw"
  | "openwebui";
export interface WorkCapabilities {
  detail: boolean;
  deepLink: boolean;
  send: boolean;
  steer: boolean;
  pause: boolean;
  approve: boolean;
  git: boolean;
}
export interface WorkSourceRef {
  adapter: AdapterName;
  sourceId: string;
  hostId: string;
  nativeId: string;
  profile?: string;
  agent?: string;
  deepLink?: string;
  capabilities: WorkCapabilities;
}
export interface ExecutionMetadata {
  host: string;
  provider?: string;
  requestedModel?: string;
  resolvedModel?: string;
  locality: Locality;
}
export interface WorkItem {
  key: string;
  id: string;
  kind: WorkKind;
  title: string;
  status: WorkStatus;
  statusConfidence: StatusConfidence;
  updatedAt: number;
  observedAt: number;
  createdAt?: number;
  archived: boolean;
  pinned: boolean;
  watched: boolean;
  latestExcerpt?: string;
  sourceRefs: WorkSourceRef[];
  execution: ExecutionMetadata;
  // Compatibility fields keep the existing Codex-oriented UI and controls narrow.
  hostId: string;
  cwd: string;
  projectId?: string;
  branch?: string;
  latest?: Message;
  messages: Message[];
  model?: string;
  error?: string;
  managed?: boolean;
  owned: boolean | null;
  turnId?: string;
  turnStatus?: string;
  controlAvailable?: boolean;
  controlReason?: string;
  briefing?: TaskBriefing;
}
export type BriefingEntryKind = "current" | "decision" | "recommendation" | "next";
export type BriefingFeedbackRating = "useful" | "wrong" | "stale";
export interface BriefingEntry {
  id: string;
  kind: BriefingEntryKind;
  taskKey?: string;
  workTitle?: string;
  actionId?: string;
  title: string;
  body: string;
  evidenceRevision: string;
  evidence: string[];
  source: "deterministic" | "model";
  analysisMode?: "coordinator" | "shadow";
  isAdvice?: boolean;
  confidence: StatusConfidence;
  updatedAt: number;
  priority: number;
  feedback?: BriefingFeedbackRating;
}
export interface TaskBriefing {
  taskKey: string;
  evidenceRevision: string;
  current: BriefingEntry;
  decision?: BriefingEntry;
  recommendation: BriefingEntry;
  next: BriefingEntry;
  attentionScore: number;
}
export interface WorkspaceBriefingSection {
  total: number;
  items: BriefingEntry[];
}
export interface WorkspaceBriefing {
  generatedAt: number;
  evidenceRevision: string;
  nowRunning: WorkspaceBriefingSection;
  decisions: WorkspaceBriefingSection;
  recommendations: WorkspaceBriefingSection;
  nextSteps: WorkspaceBriefingSection;
}
export interface SourceHealth {
  id: string;
  adapter: AdapterName;
  name: string;
  hostId: string;
  online: boolean;
  stale: boolean;
  lastSeen: number;
  error: string;
  version?: string;
  activeCount: number;
  itemCount: number;
}
interface BaseSourceConfig {
  id: string;
  name?: string;
  hostId: string;
  baseUrl: string;
  deepLinkBase?: string;
  tokenFile: string;
  enabled?: boolean;
  locality?: {
    providers?: Record<string, Locality>;
    models?: Record<string, Locality>;
    profiles?: Record<string, Locality>;
  };
}
interface LocalSourceConfig {
  id: string;
  name?: string;
  hostId: string;
  enabled?: boolean;
  locality?: {
    providers?: Record<string, Locality>;
    models?: Record<string, Locality>;
    profiles?: Record<string, Locality>;
  };
}
export interface ClaudeSourceConfig extends LocalSourceConfig {
  adapter: "claude";
  projectsDir?: string;
  sessionsDir?: string;
  maxSessions?: number;
  bridge?: { ssh: string; baseUrl?: string };
}
export interface HermesSourceConfig extends BaseSourceConfig {
  adapter: "hermes";
  profiles: string[];
}
export interface OpenWebUISourceConfig extends BaseSourceConfig {
  adapter: "openwebui";
}
export interface OpenClawSourceConfig extends BaseSourceConfig {
  adapter: "openclaw";
  deviceFile: string;
  configuredAgentsOnly?: boolean;
  reconcileSeconds?: number;
}
export type SourceConfig =
  | ClaudeSourceConfig
  | HermesSourceConfig
  | OpenWebUISourceConfig
  | OpenClawSourceConfig;
export interface RuntimeConfig {
  id?: string;
  name?: string;
  hostId: string;
  baseUrl: string;
  tokenFile?: string;
  loadedModelUrls?: string[];
}
export interface RuntimeSnapshot {
  observedAt: number;
  online: boolean;
  error: string;
  catalog: any[];
  router: any;
  metrics: Record<string, number>;
  loadedModels: any[];
  providers: string[];
}
export interface CoordinatorConfig {
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  maxActions?: number;
  /** A high-water safety rail for the complete coordinator prompt, not a daily budget. */
  maxInputChars?: number;
}
export interface ShadowProjectBoundary {
  hostId: string;
  projectId?: string | null;
  root?: string;
}
export interface ShadowAnalysisConfig {
  enabled?: boolean;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  intervalSeconds?: number;
  dailyCallLimit?: number;
  observableTokenLimit?: number;
  maxExcerptChars?: number;
  localOnlyProjects?: ShadowProjectBoundary[];
}
export interface Config {
  port: number;
  hosts: HostConfig[];
  mode?: "demo";
  sources?: SourceConfig[];
  runtime?: RuntimeConfig;
  coordinator?: CoordinatorConfig;
  shadowAnalysis?: ShadowAnalysisConfig;
  supervisorName?: string;
  publicOrigin?: string;
  allowedLogin?: string;
  auth?: {
    mode: "cloudflare-access";
    issuer: string;
    audience: string;
    allowedEmails: string[];
  };
}
export const taskKey = (host: string, id: string) => `${host}:${id}`;
