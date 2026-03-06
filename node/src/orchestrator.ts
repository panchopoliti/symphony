// Symphony Node.js — Orchestrator
// Core state machine: polling loop, dispatch, concurrency control, retry with backoff, reconciliation.
// Based on SPEC.md Sections 7, 8, 16.

import { runAgentAttempt } from './agent-runner.js';
import { removeWorkspace } from './workspace.js';
import type {
  AgentAdapter,
  AgentEvent,
  Issue,
  RetryEntry,
  RunningEntry,
  RuntimeSnapshot,
  ServiceConfig,
  TrackerAdapter,
} from './types.js';
import type { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  private config: ServiceConfig;
  private tracker: TrackerAdapter;
  private agent: AgentAdapter;
  private promptTemplate: string;
  private logger: Logger;

  // State
  private running: Map<string, RunningEntry> = new Map();
  private claimed: Set<string> = new Set();
  private retryAttempts: Map<string, RetryEntry> = new Map();
  private completed: Set<string> = new Set();
  private totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 };
  private rateLimits: unknown = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(opts: {
    config: ServiceConfig;
    tracker: TrackerAdapter;
    agent: AgentAdapter;
    promptTemplate: string;
    logger: Logger;
  }) {
    this.config = opts.config;
    this.tracker = opts.tracker;
    this.agent = opts.agent;
    this.promptTemplate = opts.promptTemplate;
    this.logger = opts.logger;
  }

  // -------------------------------------------------------------------------
  // start — validate config, run startup terminal cleanup, schedule first tick
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.logger.info('Orchestrator starting');
    this.started = true;

    // Startup terminal cleanup: remove workspaces for terminal-state issues
    try {
      const terminalIssues = await this.tracker.fetchIssuesByStates(
        this.config.tracker.terminalStates,
      );
      for (const issue of terminalIssues) {
        try {
          await removeWorkspace(
            this.config.workspace.root,
            issue.identifier,
            this.config.hooks,
          );
          this.logger.info(
            { identifier: issue.identifier },
            'Removed terminal workspace on startup',
          );
        } catch {
          // Best effort — ignore individual failures
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ error: msg }, 'Failed to fetch terminal issues for startup cleanup');
    }

    // Schedule first tick
    await this.tick();
  }

  // -------------------------------------------------------------------------
  // shutdown — clear timers, abort all workers, clear retry timers
  // -------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.logger.info('Orchestrator shutting down');
    this.started = false;

    // Clear poll timer
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Abort all running workers
    for (const [, entry] of this.running) {
      entry.abortController.abort();
    }

    // Clear all retry timers
    for (const [, entry] of this.retryAttempts) {
      if (entry.timerId !== null) {
        clearTimeout(entry.timerId);
      }
    }
    this.retryAttempts.clear();

    this.logger.info('Orchestrator shutdown complete');
  }

  // -------------------------------------------------------------------------
  // tick — per SPEC.md Section 16.2
  // -------------------------------------------------------------------------

  async tick(): Promise<void> {
    if (!this.started) return;

    try {
      // 1. Reconcile running issues
      await this.reconcile();

      // 2. Fetch candidate issues from tracker
      let candidates: Issue[];
      try {
        candidates = await this.tracker.fetchCandidateIssues();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error({ error: msg }, 'Failed to fetch candidate issues, skipping dispatch');
        this.scheduleTick();
        return;
      }

      // 3. Sort: priority asc (null last), createdAt oldest first, identifier lexicographic
      candidates.sort((a, b) => {
        const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
        const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
        if (pa !== pb) return pa - pb;

        const ca = a.createdAt?.getTime() ?? 0;
        const cb = b.createdAt?.getTime() ?? 0;
        if (ca !== cb) return ca - cb;

        return a.identifier.localeCompare(b.identifier);
      });

      // 4. Dispatch eligible issues while slots available
      for (const issue of candidates) {
        if (!this.hasGlobalSlots()) break;
        this.dispatch(issue, null);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ error: msg }, 'Tick error');
    }

    // 5. Schedule next tick
    this.scheduleTick();
  }

  // -------------------------------------------------------------------------
  // reconcile — per SPEC.md Section 16.3
  // -------------------------------------------------------------------------

  async reconcile(): Promise<void> {
    if (this.running.size === 0) return;

    const now = Date.now();

    // Part A: Stall detection
    const stallTimeoutMs = 300_000; // 5 minutes default
    if (stallTimeoutMs > 0) {
      for (const [issueId, entry] of this.running) {
        const referenceTime = entry.lastEventAt ?? entry.startedAt;
        const elapsed = now - referenceTime.getTime();
        if (elapsed > stallTimeoutMs) {
          this.logger.warn(
            { issueId, identifier: entry.identifier, elapsed },
            'Stall detected, aborting worker',
          );
          entry.abortController.abort();
          // Retry will be scheduled in onWorkerExit
        }
      }
    }

    // Part B: Tracker state refresh
    const runningIds = Array.from(this.running.keys());
    if (runningIds.length === 0) return;

    let refreshed: Issue[];
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds(runningIds);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ error: msg }, 'State refresh failed, keeping workers running');
      return;
    }

    const refreshMap = new Map(refreshed.map((i) => [i.id, i]));

    for (const [issueId, entry] of this.running) {
      const current = refreshMap.get(issueId);
      if (!current) continue;

      const isTerminal = this.config.tracker.terminalStates.some(
        (s) => s.toLowerCase() === current.state.toLowerCase(),
      );
      const isActive = this.config.tracker.activeStates.some(
        (s) => s.toLowerCase() === current.state.toLowerCase(),
      );

      if (isTerminal) {
        this.logger.info(
          { issueId, identifier: entry.identifier, state: current.state },
          'Issue is terminal, stopping worker and cleaning workspace',
        );
        entry.abortController.abort();
        // Clean workspace for terminal issues
        try {
          await removeWorkspace(
            this.config.workspace.root,
            entry.identifier,
            this.config.hooks,
          );
        } catch {
          // Best effort
        }
      } else if (!isActive) {
        this.logger.info(
          { issueId, identifier: entry.identifier, state: current.state },
          'Issue no longer active, stopping worker',
        );
        entry.abortController.abort();
      }
      // If still active, nothing to do — worker continues
    }
  }

  // -------------------------------------------------------------------------
  // dispatch — per SPEC.md Section 16.4
  // -------------------------------------------------------------------------

  dispatch(issue: Issue, attempt: number | null): void {
    const issueId = issue.id;

    // Check not already running or claimed
    if (this.running.has(issueId) || this.claimed.has(issueId)) {
      return;
    }

    // Check global concurrency
    if (!this.hasGlobalSlots()) {
      return;
    }

    // Check per-state concurrency
    if (!this.hasStateSlots(issue.state)) {
      return;
    }

    // Blocker rule: if state matches "Todo" (case-insensitive), check blockers
    if (issue.state.toLowerCase() === 'todo' && issue.blockedBy.length > 0) {
      const hasNonTerminalBlocker = issue.blockedBy.some((blocker) => {
        if (!blocker.state) return true; // Unknown state = assume non-terminal
        return !this.config.tracker.terminalStates.some(
          (ts) => ts.toLowerCase() === blocker.state!.toLowerCase(),
        );
      });
      if (hasNonTerminalBlocker) {
        this.logger.debug(
          { issueId, identifier: issue.identifier },
          'Skipping blocked Todo issue',
        );
        return;
      }
    }

    // Create AbortController and start worker
    const abortController = new AbortController();
    const sessionId = `session-${issueId}-${Date.now()}`;
    const startedAt = new Date();

    const entry: RunningEntry = {
      issueId,
      identifier: issue.identifier,
      issue,
      abortController,
      sessionId,
      turnCount: 0,
      startedAt,
      lastEvent: null,
      lastEventAt: null,
      lastMessage: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      retryAttempt: attempt,
    };

    this.running.set(issueId, entry);
    this.claimed.add(issueId);

    this.logger.info(
      { issueId, identifier: issue.identifier, attempt },
      'Dispatching agent worker',
    );

    // Fire-and-forget — worker exit handled via .then/.catch
    runAgentAttempt({
      issue,
      attempt,
      config: this.config,
      promptTemplate: this.promptTemplate,
      tracker: this.tracker,
      agent: this.agent,
      logger: this.logger,
      onUpdate: (event: AgentEvent) => this.onWorkerEvent(issueId, event),
      signal: abortController.signal,
    }).then(
      (result) => {
        // Only 'completed' (issue left active state) is a true normal exit.
        // 'max_turns_reached' and 'cancelled' need abnormal handling (exponential backoff)
        // to avoid infinite retry loops and backoff resets.
        const reason = result.status === 'completed' ? 'normal' : 'abnormal';
        const error = result.status === 'completed' ? undefined : (result.error ?? result.status);
        this.onWorkerExit(issueId, reason, result.totalTokens, error);
      },
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error({ issueId, error: msg }, 'Worker failed with exception');
        this.onWorkerExit(issueId, 'abnormal', null, msg);
      },
    );
  }

  // -------------------------------------------------------------------------
  // onWorkerEvent — handle agent events from running workers
  // -------------------------------------------------------------------------

  private onWorkerEvent(issueId: string, event: AgentEvent): void {
    const entry = this.running.get(issueId);
    if (!entry) return;

    entry.lastEvent = event.event;
    entry.lastEventAt = new Date();
    if (event.usage) {
      entry.inputTokens = event.usage.inputTokens;
      entry.outputTokens = event.usage.outputTokens;
      entry.totalTokens = event.usage.totalTokens;
    }
  }

  // -------------------------------------------------------------------------
  // onWorkerExit — per SPEC.md Section 16.6
  // -------------------------------------------------------------------------

  private onWorkerExit(
    issueId: string,
    reason: 'normal' | 'abnormal',
    tokens: { inputTokens: number; outputTokens: number; totalTokens: number } | null,
    error?: string,
  ): void {
    const entry = this.running.get(issueId);
    if (!entry) return;

    // Remove from running
    this.running.delete(issueId);

    // Accumulate runtime seconds
    const elapsed = (Date.now() - entry.startedAt.getTime()) / 1000;
    this.totals.secondsRunning += elapsed;

    // Accumulate token totals
    if (tokens) {
      this.totals.inputTokens += tokens.inputTokens;
      this.totals.outputTokens += tokens.outputTokens;
      this.totals.totalTokens += tokens.totalTokens;
    }

    // Add to completed set (bookkeeping)
    this.completed.add(issueId);

    if (reason === 'normal') {
      // Schedule continuation retry (attempt 1) with 1s delay
      this.logger.info({ issueId, identifier: entry.identifier }, 'Worker exited normally, scheduling continuation');
      this.scheduleRetry(issueId, 1, { identifier: entry.identifier, error: null });
    } else {
      // Schedule exponential backoff retry
      const currentAttempt = entry.retryAttempt ?? 0;
      const nextAttempt = currentAttempt + 1;
      this.logger.warn(
        { issueId, identifier: entry.identifier, attempt: nextAttempt, error },
        'Worker exited abnormally, scheduling retry',
      );
      this.scheduleRetry(issueId, nextAttempt, {
        identifier: entry.identifier,
        error: error ?? 'unknown error',
      });
    }
  }

  // -------------------------------------------------------------------------
  // scheduleRetry — per SPEC.md Section 16.6
  // -------------------------------------------------------------------------

  private scheduleRetry(
    issueId: string,
    attempt: number,
    opts: { identifier: string; error: string | null },
  ): void {
    // Cancel existing retry timer
    const existing = this.retryAttempts.get(issueId);
    if (existing?.timerId !== null && existing?.timerId !== undefined) {
      clearTimeout(existing.timerId);
    }

    // Compute delay: continuation (attempt=1 with no error) = 1000ms, failure = exponential
    const isContinuation = attempt === 1 && opts.error === null;
    const delay = isContinuation
      ? 1000
      : Math.min(10000 * Math.pow(2, attempt - 1), this.config.agent.maxRetryBackoffMs);

    const dueAtMs = Date.now() + delay;

    const timerId = setTimeout(() => {
      this.onRetryTimer(issueId).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error({ issueId, error: msg }, 'Retry timer handler error');
      });
    }, delay);

    const retryEntry: RetryEntry = {
      issueId,
      identifier: opts.identifier,
      attempt,
      dueAtMs,
      timerId,
      error: opts.error,
    };

    this.retryAttempts.set(issueId, retryEntry);
    this.logger.info(
      { issueId, identifier: opts.identifier, attempt, delay },
      'Retry scheduled',
    );
  }

  // -------------------------------------------------------------------------
  // onRetryTimer — per SPEC.md Section 16.6 retry handler
  // -------------------------------------------------------------------------

  private async onRetryTimer(issueId: string): Promise<void> {
    const retryEntry = this.retryAttempts.get(issueId);
    if (!retryEntry) return;

    this.retryAttempts.delete(issueId);

    this.logger.info(
      { issueId, identifier: retryEntry.identifier, attempt: retryEntry.attempt },
      'Retry timer fired',
    );

    // Fetch candidate issues to check if still eligible
    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ issueId, error: msg }, 'Failed to fetch candidates during retry');
      // Release claim
      this.claimed.delete(issueId);
      return;
    }

    const issue = candidates.find((c) => c.id === issueId);

    if (!issue) {
      // Not found or no longer a candidate — release claim
      this.logger.info({ issueId }, 'Issue no longer a candidate, releasing claim');
      this.claimed.delete(issueId);
      return;
    }

    // Check if we have slots
    if (!this.hasGlobalSlots() || !this.hasStateSlots(issue.state)) {
      // Requeue with slot-unavailable error
      this.logger.info(
        { issueId, identifier: retryEntry.identifier },
        'No available slots for retry, requeuing',
      );
      this.scheduleRetry(issueId, retryEntry.attempt, {
        identifier: retryEntry.identifier,
        error: 'no available orchestrator slots',
      });
      return;
    }

    // Dispatch the retry — claimed is already set
    this.claimed.delete(issueId); // dispatch will re-add it
    this.dispatch(issue, retryEntry.attempt);
  }

  // -------------------------------------------------------------------------
  // Concurrency helpers
  // -------------------------------------------------------------------------

  private hasGlobalSlots(): boolean {
    return this.running.size < this.config.agent.maxConcurrentAgents;
  }

  private hasStateSlots(state: string): boolean {
    const stateKey = state.toLowerCase();
    const limit = this.config.agent.maxConcurrentAgentsByState[stateKey];
    if (limit === undefined) return true; // No per-state limit set

    let count = 0;
    for (const [, entry] of this.running) {
      if (entry.issue.state.toLowerCase() === stateKey) {
        count++;
      }
    }
    return count < limit;
  }

  // -------------------------------------------------------------------------
  // scheduleTick — schedule next poll
  // -------------------------------------------------------------------------

  private scheduleTick(): void {
    if (!this.started) return;
    this.pollTimer = setTimeout(() => {
      this.tick().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error({ error: msg }, 'Tick error');
      });
    }, this.config.polling.intervalMs);
  }

  // -------------------------------------------------------------------------
  // getSnapshot — for HTTP API and dashboard
  // -------------------------------------------------------------------------

  getSnapshot(): RuntimeSnapshot {
    return {
      running: Array.from(this.running.values()),
      retrying: Array.from(this.retryAttempts.values()),
      codexTotals: { ...this.totals },
      rateLimits: this.rateLimits,
      generatedAt: new Date(),
      counts: {
        running: this.running.size,
        retrying: this.retryAttempts.size,
        claimed: this.claimed.size,
        completed: this.completed.size,
      },
    };
  }

  // -------------------------------------------------------------------------
  // updateConfig — hot reload support
  // -------------------------------------------------------------------------

  updateConfig(config: ServiceConfig, promptTemplate: string): void {
    this.config = config;
    this.promptTemplate = promptTemplate;
    this.logger.info('Config updated (hot reload)');
  }

  // -------------------------------------------------------------------------
  // triggerRefresh — immediate tick (for HTTP API)
  // -------------------------------------------------------------------------

  triggerRefresh(): void {
    // Cancel pending tick and run immediately
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.tick().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ error: msg }, 'Triggered refresh tick error');
    });
  }
}
