// pi-prompt-playbook-boost v2 — Shared types

// --- Exec function type (wraps pi.exec) ---

export type ExecFn = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

// --- Git Analysis Types ---

export interface FileChange {
  added: number;
  deleted: number;
  path: string;
}

export interface CommitInfo {
  hash: string;
  date: string;
  author: string;
  message: string;
  files: FileChange[];
}

export interface FixChain {
  featureCommit: CommitInfo;
  fixCommit: CommitInfo;
  sharedFiles: string[];
  hoursBetween: number;
}

export interface CouplingRule {
  fileA: string;
  fileB: string;
  coOccurrences: number;
  couplingRate: number;
  totalCommitsA: number;
  totalCommitsB: number;
}

export interface GitAnalysis {
  commits: CommitInfo[];
  totalCommits: number;
  fixChains: FixChain[];
  couplingRules: CouplingRule[];
  hotspots: { path: string; commitCount: number; fixCount: number }[];
  cleanCommitRate: number;
  authors: string[];
  dateRange: { earliest: string; latest: string } | null;
}

export interface CommitScanResult {
  newCommits: CommitInfo[];
  newFixChains: FixChain[];
  newHash: string;
}

export interface DetectedFixPattern {
  fixCommit: CommitInfo;
  affectedFiles: string[];
  /** Hash of the feature commit this fix likely corrects, or empty string. */
  likelyFixFor: string;
}

// --- Session Analysis Types ---

export interface SessionMessage {
  role: string;
  content: string;
  timestamp?: number;
}

export interface PromptPattern {
  pattern: string;
  count: number;
  avgTurns: number;
}

export interface SessionAnalysis {
  totalSessions: number;
  totalMessages: number;
  totalUserMessages: number;
  retryCount: number;
  promptPatterns: PromptPattern[];
  avgTurnsPerSession: number;
  toolErrorCount: number;
}

// --- Codebase Analysis Types ---

export interface TechStack {
  language: string;
  framework: string | null;
  orm: string | null;
  styling: string | null;
  stateManagement: string | null;
  packageManager: string | null;
  monorepo: boolean;
  dependencies: string[];
}

export interface ExistingRule {
  source: string;
  path: string;
  content: string;
}

export interface LinterConfig {
  tool: string;           // "ESLint" | "Biome" | "Prettier"
  configPath: string;
  content: string;        // raw config content (truncated to 3000 chars)
}

export interface CiWorkflow {
  name: string;           // filename
  path: string;
  content: string;        // raw YAML content (truncated to 3000 chars)
}

export interface CodebaseAnalysis {
  stack: TechStack;
  testFramework: string | null;
  buildCommands: string[];
  lintCommands: string[];
  existingRules: ExistingRule[];
  keyDirectories: string[];
  filePatterns: { extension: string; count: number }[];
  linterConfig: LinterConfig | null;
  importAliases: Record<string, string>;
  ciWorkflows: CiWorkflow[];
  envVars: string[];
  projectDocs: ExistingRule[];
}

// --- Interaction Tracking Types ---

export interface InteractionRecord {
  id: string;
  timestamp: number;
  sessionId: string;
  promptRaw: string;
  sectionsUsed: string[];
  turns: number;
  totalToolCalls: number;
  toolErrors: number;
  retried: boolean;
  intent?: string;
}

// --- Scoring Types ---

export interface ScoringSignals {
  turnEfficiency: number;
  errorFree: number;
  noRetry: number;
}

export interface ScoringResult {
  signals: ScoringSignals;
  composite: number;
}

// --- Playbook Update Types ---

export interface PendingUpdate {
  id: string;
  type: "new_rule" | "update_stat" | "new_convention";
  section: string;
  content: string;
  evidence: string;
  confidence: number;
  created: string;
  status?: "pending" | "accepted" | "rejected";
}

// --- Extension State ---

export interface BoostState {
  lastScanHash: string;
  interactionCount: number;
  shareWithTeam: boolean;
  lastUpdated: string;
  setupComplete: boolean;
  autosend?: boolean;
}
