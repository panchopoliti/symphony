// Symphony Node.js — Config Layer
// Applies defaults, resolves env vars, expands paths, validates.

import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServiceConfig } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve `$VAR_NAME` references in a string value from process.env.
 * Returns the resolved string, or undefined if the env var is empty/unset.
 */
function resolveEnvVar(value: unknown): string | undefined {
  if (typeof value !== 'string') return value as undefined;
  if (!value.startsWith('$')) return value;
  const varName = value.slice(1);
  const resolved = process.env[varName];
  if (!resolved || resolved.trim() === '') return undefined;
  return resolved;
}

/**
 * Expand `~` at the start of a path to the user's home directory.
 */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Coerce a value to number. Returns default if not a valid number.
 */
function toInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'string' ? parseInt(value, 10) : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Coerce a value to a string list. Supports arrays and comma-separated strings.
 */
function toStringList(value: unknown, fallback: string[]): string[] {
  if (value === undefined || value === null) return fallback;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return fallback;
}

// ---------------------------------------------------------------------------
// parseConfig — apply defaults, resolve env vars, expand paths
// ---------------------------------------------------------------------------

export function parseConfig(raw: Record<string, unknown>): ServiceConfig {
  const tracker = (raw.tracker ?? {}) as Record<string, unknown>;
  const polling = (raw.polling ?? {}) as Record<string, unknown>;
  const workspace = (raw.workspace ?? {}) as Record<string, unknown>;
  const hooks = (raw.hooks ?? {}) as Record<string, unknown>;
  const agent = (raw.agent ?? {}) as Record<string, unknown>;
  const claude = (raw.claude ?? {}) as Record<string, unknown>;
  const server = (raw.server ?? {}) as Record<string, unknown>;

  // Resolve tracker.api_key (supports $VAR_NAME)
  const resolvedApiKey = resolveEnvVar(tracker.api_key) ?? '';

  // Resolve workspace.root (supports $VAR_NAME and ~ expansion)
  let workspaceRoot: string;
  const rawRoot = tracker.kind ? workspace.root : workspace.root;
  if (rawRoot !== undefined && rawRoot !== null) {
    const resolved = resolveEnvVar(rawRoot);
    workspaceRoot = expandHome(resolved ?? String(rawRoot));
  } else {
    workspaceRoot = join(tmpdir(), 'symphony_workspaces');
  }

  // Parse max_concurrent_agents_by_state map
  const byStateRaw = (agent.max_concurrent_agents_by_state ?? {}) as Record<string, unknown>;
  const maxConcurrentAgentsByState: Record<string, number> = {};
  for (const [key, val] of Object.entries(byStateRaw)) {
    const n = toInt(val, -1);
    if (n > 0) {
      maxConcurrentAgentsByState[key.trim().toLowerCase()] = n;
    }
  }

  // Resolve hooks timeout — non-positive values fall back to default
  const hookTimeoutMs = toInt(hooks.timeout_ms, 60000);
  const effectiveHookTimeoutMs = hookTimeoutMs > 0 ? hookTimeoutMs : 60000;

  return {
    tracker: {
      kind: typeof tracker.kind === 'string' ? tracker.kind : '',
      endpoint: typeof tracker.endpoint === 'string'
        ? tracker.endpoint
        : tracker.kind === 'asana'
          ? 'https://app.asana.com/api/1.0'
          : 'https://api.linear.app/graphql',
      apiKey: resolvedApiKey,
      projectId: typeof tracker.project_id === 'string' ? tracker.project_id : '',
      activeStates: toStringList(tracker.active_states, ['Ready to start', 'In Progress']),
      terminalStates: toStringList(tracker.terminal_states, ['Shipped']),
    },
    polling: {
      intervalMs: toInt(polling.interval_ms, 30000),
    },
    workspace: {
      root: workspaceRoot,
    },
    hooks: {
      afterCreate: typeof hooks.after_create === 'string' ? hooks.after_create : null,
      beforeRun: typeof hooks.before_run === 'string' ? hooks.before_run : null,
      afterRun: typeof hooks.after_run === 'string' ? hooks.after_run : null,
      beforeRemove: typeof hooks.before_remove === 'string' ? hooks.before_remove : null,
      timeoutMs: effectiveHookTimeoutMs,
    },
    agent: {
      maxConcurrentAgents: toInt(agent.max_concurrent_agents, 10),
      maxTurns: toInt(agent.max_turns, 20),
      maxRetryBackoffMs: toInt(agent.max_retry_backoff_ms, 300000),
      maxConcurrentAgentsByState,
    },
    claude: {
      model: typeof claude.model === 'string' ? claude.model : 'claude-sonnet-4-20250514',
      provider: claude.provider === 'api' ? 'api' : 'cli',
    },
    server: {
      port: server.port !== undefined && server.port !== null ? toInt(server.port, 0) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// validateConfig — check required fields for dispatch readiness
// ---------------------------------------------------------------------------

export function validateConfig(config: ServiceConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.tracker.kind) {
    errors.push('tracker.kind is required');
  }

  if (!config.tracker.apiKey) {
    errors.push('tracker.api_key is required (check env var resolution)');
  }

  if (!config.tracker.projectId) {
    errors.push('tracker.project_id is required');
  }

  if (config.tracker.activeStates.length === 0) {
    errors.push('tracker.active_states must have at least one state');
  }

  return { valid: errors.length === 0, errors };
}
