// Symphony Node.js — Domain Types
// Based on SPEC.md Section 4.1 (Entities) and Section 6.4 (Config Cheat Sheet)

// ---------------------------------------------------------------------------
// 4.1.1 — Issue (normalized from tracker)
// ---------------------------------------------------------------------------

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: Date | null;
  updatedAt: Date | null;
}

// ---------------------------------------------------------------------------
// 4.1.2 — WorkflowDefinition
// ---------------------------------------------------------------------------

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
}

// ---------------------------------------------------------------------------
// 4.1.3 — ServiceConfig (typed runtime config)
// ---------------------------------------------------------------------------

export interface TrackerConfig {
  kind: string;
  endpoint: string;
  apiKey: string;
  projectId: string;
  activeStates: string[];
  terminalStates: string[];
}

export interface PollingConfig {
  intervalMs: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Record<string, number>;
}

export interface ClaudeConfig {
  model: string;
  provider: 'cli' | 'api';
}

export interface ServerConfig {
  port: number | null;
}

export interface ServiceConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  claude: ClaudeConfig;
  server: ServerConfig;
}

// ---------------------------------------------------------------------------
// 4.1.5 — RunningEntry (live agent session metadata)
// ---------------------------------------------------------------------------

export interface RunningEntry {
  issueId: string;
  identifier: string;
  issue: Issue;
  abortController: AbortController;
  sessionId: string | null;
  turnCount: number;
  startedAt: Date;
  lastEvent: AgentEventType | null;
  lastEventAt: Date | null;
  lastMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  retryAttempt: number | null;
}

// ---------------------------------------------------------------------------
// 4.1.7 — RetryEntry
// ---------------------------------------------------------------------------

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timerId: ReturnType<typeof setTimeout> | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// 4.1.8 — RuntimeSnapshot (for HTTP API and dashboards)
// ---------------------------------------------------------------------------

export interface CodexTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

export interface RuntimeSnapshot {
  running: RunningEntry[];
  retrying: RetryEntry[];
  codexTotals: CodexTotals;
  rateLimits: unknown;
  generatedAt: Date;
  counts: {
    running: number;
    retrying: number;
    claimed: number;
    completed: number;
  };
}

// ---------------------------------------------------------------------------
// Agent Events (Section 10.4)
// ---------------------------------------------------------------------------

export type AgentEventType =
  | 'session_started'
  | 'startup_failed'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_ended_with_error'
  | 'turn_input_required'
  | 'notification'
  | 'other_message'
  | 'malformed';

export interface AgentEvent {
  event: AgentEventType;
  timestamp: Date;
  sessionId: string | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Run Attempt Status (Section 7.2)
// ---------------------------------------------------------------------------

export type RunAttemptStatus =
  | 'PreparingWorkspace'
  | 'BuildingPrompt'
  | 'LaunchingAgentProcess'
  | 'InitializingSession'
  | 'StreamingTurn'
  | 'Finishing'
  | 'Succeeded'
  | 'Failed'
  | 'TimedOut'
  | 'Stalled'
  | 'CanceledByReconciliation';

// ---------------------------------------------------------------------------
// Turn Result (returned from AgentAdapter.runTurn)
// ---------------------------------------------------------------------------

export interface TurnResult {
  status: 'completed' | 'failed' | 'cancelled';
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  stepCount: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Adapter Interfaces
// ---------------------------------------------------------------------------

export interface TrackerAdapter {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(states: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(ids: string[]): Promise<Issue[]>;
}

export interface AgentAdapter {
  runTurn(opts: {
    prompt: string;
    workspacePath: string;
    config: ServiceConfig;
    onMessage: (event: AgentEvent) => void;
    signal: AbortSignal;
  }): Promise<TurnResult>;
}
