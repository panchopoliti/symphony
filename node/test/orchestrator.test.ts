import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../src/orchestrator.js';
import type {
  AgentAdapter,
  AgentEvent,
  Issue,
  ServiceConfig,
  TrackerAdapter,
  TurnResult,
} from '../src/types.js';
import type { Logger } from '../src/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: 'issue-1',
    identifier: 'issue-1',
    title: 'Test issue',
    description: 'Fix the bug',
    priority: null,
    state: 'In Progress',
    branchName: null,
    url: 'https://example.com/issue-1',
    labels: [],
    blockedBy: [],
    createdAt: new Date('2026-03-01'),
    updatedAt: new Date('2026-03-01'),
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<ServiceConfig>): ServiceConfig {
  return {
    tracker: {
      kind: 'asana',
      endpoint: 'https://app.asana.com/api/1.0',
      apiKey: 'test-key',
      projectId: 'proj-1',
      activeStates: ['In Progress', 'Ready to start'],
      terminalStates: ['Shipped'],
    },
    polling: { intervalMs: 60000 }, // Long interval so ticks don't auto-fire during tests
    workspace: { root: '/tmp/test-workspaces' },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60000,
    },
    agent: {
      maxConcurrentAgents: 10,
      maxTurns: 5,
      maxRetryBackoffMs: 300000,
      maxConcurrentAgentsByState: {},
    },
    claude: { model: 'claude-sonnet-4-20250514' },
    server: { port: null },
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function makeTurnResult(overrides?: Partial<TurnResult>): TurnResult {
  return {
    status: 'completed',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    stepCount: 3,
    ...overrides,
  };
}

// Mock the agent-runner module
vi.mock('../src/agent-runner.js', () => ({
  runAgentAttempt: vi.fn(),
}));

// Mock the workspace module
vi.mock('../src/workspace.js', () => ({
  removeWorkspace: vi.fn(),
  createForIssue: vi.fn(),
  runHook: vi.fn(),
  workspacePath: vi.fn(),
}));

import { runAgentAttempt } from '../src/agent-runner.js';
import { removeWorkspace } from '../src/workspace.js';

describe('Orchestrator', () => {
  let mockTracker: TrackerAdapter;
  let mockAgent: AgentAdapter;
  let mockLogger: Logger;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockLogger = makeLogger();

    mockTracker = {
      fetchCandidateIssues: vi.fn().mockResolvedValue([]),
      fetchIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([]),
    };

    mockAgent = {
      runTurn: vi.fn().mockResolvedValue(makeTurnResult()),
    };

    // Default: runAgentAttempt resolves normally
    (runAgentAttempt as ReturnType<typeof vi.fn>).mockResolvedValue({
      turnCount: 1,
      totalTokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      status: 'completed',
    });

    (removeWorkspace as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    orchestrator = new Orchestrator({
      config: makeConfig(),
      tracker: mockTracker,
      agent: mockAgent,
      promptTemplate: 'Fix {{ issue.title }}',
      logger: mockLogger,
    });
  });

  afterEach(async () => {
    await orchestrator.shutdown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Dispatch eligibility
  // -----------------------------------------------------------------------

  describe('dispatch', () => {
    it('dispatches an eligible issue', async () => {
      const issue = makeIssue();
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([issue]);

      await orchestrator.start();

      expect(runAgentAttempt).toHaveBeenCalledOnce();
      const callOpts = (runAgentAttempt as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callOpts.issue.id).toBe('issue-1');
      expect(callOpts.attempt).toBeNull();
    });

    it('does not dispatch the same issue twice (claimed set)', async () => {
      const issue = makeIssue();
      // runAgentAttempt never resolves during this test (worker stays running)
      (runAgentAttempt as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([issue]);

      await orchestrator.start();

      // Force another tick
      await orchestrator.tick();

      // Should only dispatch once
      expect(runAgentAttempt).toHaveBeenCalledOnce();
    });

    it('respects global concurrency limit', async () => {
      const config = makeConfig({
        agent: {
          maxConcurrentAgents: 2,
          maxTurns: 5,
          maxRetryBackoffMs: 300000,
          maxConcurrentAgentsByState: {},
        },
      });

      orchestrator = new Orchestrator({
        config,
        tracker: mockTracker,
        agent: mockAgent,
        promptTemplate: 'Fix it',
        logger: mockLogger,
      });

      const issues = [
        makeIssue({ id: 'a', identifier: 'a' }),
        makeIssue({ id: 'b', identifier: 'b' }),
        makeIssue({ id: 'c', identifier: 'c' }),
      ];

      // Workers never resolve
      (runAgentAttempt as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue(issues);

      await orchestrator.start();

      // Only 2 should be dispatched
      expect(runAgentAttempt).toHaveBeenCalledTimes(2);
    });

    it('respects per-state concurrency limit', async () => {
      const config = makeConfig({
        agent: {
          maxConcurrentAgents: 10,
          maxTurns: 5,
          maxRetryBackoffMs: 300000,
          maxConcurrentAgentsByState: { 'in progress': 1 },
        },
      });

      orchestrator = new Orchestrator({
        config,
        tracker: mockTracker,
        agent: mockAgent,
        promptTemplate: 'Fix it',
        logger: mockLogger,
      });

      const issues = [
        makeIssue({ id: 'a', identifier: 'a', state: 'In Progress' }),
        makeIssue({ id: 'b', identifier: 'b', state: 'In Progress' }),
      ];

      (runAgentAttempt as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue(issues);

      await orchestrator.start();

      // Only 1 "In Progress" should be dispatched
      expect(runAgentAttempt).toHaveBeenCalledOnce();
    });

    it('blocks Todo issues with non-terminal blockers', async () => {
      const issue = makeIssue({
        id: 'blocked-1',
        identifier: 'blocked-1',
        state: 'Todo',
        blockedBy: [{ id: 'dep-1', identifier: 'DEP-1', state: 'In Progress' }],
      });

      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([issue]);

      await orchestrator.start();

      expect(runAgentAttempt).not.toHaveBeenCalled();
    });

    it('dispatches Todo issues when all blockers are terminal', async () => {
      const issue = makeIssue({
        id: 'unblocked-1',
        identifier: 'unblocked-1',
        state: 'Todo',
        blockedBy: [{ id: 'dep-1', identifier: 'DEP-1', state: 'Shipped' }],
      });

      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([issue]);

      await orchestrator.start();

      expect(runAgentAttempt).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // Sort order
  // -----------------------------------------------------------------------

  describe('sort order', () => {
    it('sorts by priority asc, createdAt oldest first, identifier lexicographic', async () => {
      const issues = [
        makeIssue({ id: 'c', identifier: 'c', priority: 3, createdAt: new Date('2026-03-03') }),
        makeIssue({ id: 'a', identifier: 'a', priority: 1, createdAt: new Date('2026-03-01') }),
        makeIssue({ id: 'b', identifier: 'b', priority: 1, createdAt: new Date('2026-03-02') }),
        makeIssue({ id: 'd', identifier: 'd', priority: null, createdAt: new Date('2026-03-01') }),
      ];

      (runAgentAttempt as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue(issues);

      await orchestrator.start();

      const calls = (runAgentAttempt as ReturnType<typeof vi.fn>).mock.calls;
      const dispatched = calls.map((c: unknown[]) => (c[0] as { issue: Issue }).issue.id);

      // priority 1 issues first (a before b by date), then priority 3 (c), then null priority (d)
      expect(dispatched).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  // -----------------------------------------------------------------------
  // Retry backoff
  // -----------------------------------------------------------------------

  describe('retry backoff', () => {
    it('schedules continuation retry with 1s delay on normal exit', async () => {
      const issue = makeIssue();
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([issue]);

      // Worker completes normally
      (runAgentAttempt as ReturnType<typeof vi.fn>).mockResolvedValue({
        turnCount: 1,
        totalTokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        status: 'completed',
      });

      await orchestrator.start();

      // Let the worker promise resolve
      await vi.advanceTimersByTimeAsync(0);

      const snapshot = orchestrator.getSnapshot();
      expect(snapshot.counts.retrying).toBe(1);
      expect(snapshot.retrying[0].attempt).toBe(1);
      expect(snapshot.retrying[0].error).toBeNull(); // continuation has no error
    });

    it('schedules exponential backoff retry on abnormal exit', async () => {
      const issue = makeIssue();
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([issue]);

      // Worker fails with error
      (runAgentAttempt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('agent crashed'));

      await orchestrator.start();

      // Let the rejection propagate
      await vi.advanceTimersByTimeAsync(0);

      const snapshot = orchestrator.getSnapshot();
      expect(snapshot.counts.retrying).toBe(1);
      expect(snapshot.retrying[0].error).toBe('agent crashed');
    });

    it('calculates backoff delay as min(10000 * 2^(attempt-1), maxRetryBackoffMs)', async () => {
      const config = makeConfig({
        agent: {
          maxConcurrentAgents: 10,
          maxTurns: 5,
          maxRetryBackoffMs: 60000,
          maxConcurrentAgentsByState: {},
        },
      });

      orchestrator = new Orchestrator({
        config,
        tracker: mockTracker,
        agent: mockAgent,
        promptTemplate: 'Fix it',
        logger: mockLogger,
      });

      const issue = makeIssue();
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([issue]);
      (runAgentAttempt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(0);

      // First failure → attempt 1 → delay = min(10000 * 2^0, 60000) = 10000ms
      const snapshot = orchestrator.getSnapshot();
      expect(snapshot.retrying[0].attempt).toBe(1);
      // dueAtMs should be ~10s from now
      const expectedDelay = 10000;
      const now = Date.now();
      expect(snapshot.retrying[0].dueAtMs).toBeGreaterThanOrEqual(now);
      expect(snapshot.retrying[0].dueAtMs).toBeLessThanOrEqual(now + expectedDelay + 100);
    });
  });

  // -----------------------------------------------------------------------
  // Reconciliation
  // -----------------------------------------------------------------------

  describe('reconciliation', () => {
    it('stops workers whose issues are in terminal state', async () => {
      const issue = makeIssue();
      // Worker runs forever
      (runAgentAttempt as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([issue]);

      await orchestrator.start();

      expect(orchestrator.getSnapshot().counts.running).toBe(1);

      // On next tick, tracker says issue is terminal
      (mockTracker.fetchIssueStatesByIds as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeIssue({ state: 'Shipped' }),
      ]);
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await orchestrator.tick();

      // removeWorkspace should be called for terminal issue
      expect(removeWorkspace).toHaveBeenCalledWith(
        '/tmp/test-workspaces',
        'issue-1',
        expect.any(Object),
      );
    });

    it('stops workers whose issues are no longer active (non-terminal)', async () => {
      const issue = makeIssue();
      (runAgentAttempt as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([issue]);

      await orchestrator.start();

      // On next tick, issue is in some unknown state (not active, not terminal)
      (mockTracker.fetchIssueStatesByIds as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeIssue({ state: 'Backlog' }),
      ]);
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await orchestrator.tick();

      // Should NOT clean workspace for non-terminal
      expect(removeWorkspace).not.toHaveBeenCalled();
    });

    it('stall detection aborts workers inactive beyond timeout', async () => {
      const issue = makeIssue();
      let abortSignal: AbortSignal | null = null;

      (runAgentAttempt as ReturnType<typeof vi.fn>).mockImplementation(
        (opts: { signal: AbortSignal }) => {
          abortSignal = opts.signal;
          return new Promise(() => {}); // Never resolves
        },
      );
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([issue]);

      await orchestrator.start();

      expect(abortSignal).not.toBeNull();
      expect(abortSignal!.aborted).toBe(false);

      // Advance time past stall timeout (5 minutes)
      await vi.advanceTimersByTimeAsync(301_000);

      // Mock state refresh so reconcile doesn't error
      (mockTracker.fetchIssueStatesByIds as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeIssue({ state: 'In Progress' }),
      ]);
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await orchestrator.tick();

      // Signal should have been aborted
      expect(abortSignal!.aborted).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // getSnapshot
  // -----------------------------------------------------------------------

  describe('getSnapshot', () => {
    it('returns current runtime state', async () => {
      const snapshot = orchestrator.getSnapshot();

      expect(snapshot.running).toEqual([]);
      expect(snapshot.retrying).toEqual([]);
      expect(snapshot.codexTotals).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        secondsRunning: 0,
      });
      expect(snapshot.counts).toEqual({
        running: 0,
        retrying: 0,
        claimed: 0,
        completed: 0,
      });
      expect(snapshot.generatedAt).toBeInstanceOf(Date);
    });

    it('reflects running issues', async () => {
      const issue = makeIssue();
      (runAgentAttempt as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([issue]);

      await orchestrator.start();

      const snapshot = orchestrator.getSnapshot();
      expect(snapshot.counts.running).toBe(1);
      expect(snapshot.counts.claimed).toBe(1);
      expect(snapshot.running[0].issueId).toBe('issue-1');
    });
  });

  // -----------------------------------------------------------------------
  // Hot reload
  // -----------------------------------------------------------------------

  describe('updateConfig', () => {
    it('updates config and prompt template', () => {
      const newConfig = makeConfig({ polling: { intervalMs: 5000 } });
      orchestrator.updateConfig(newConfig, 'New template: {{ issue.title }}');

      // No error thrown, config updated
      expect(mockLogger.info).toHaveBeenCalledWith('Config updated (hot reload)');
    });
  });

  // -----------------------------------------------------------------------
  // triggerRefresh
  // -----------------------------------------------------------------------

  describe('triggerRefresh', () => {
    it('triggers an immediate tick', async () => {
      const issue = makeIssue();
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([issue]);

      await orchestrator.start();
      const firstCallCount = (runAgentAttempt as ReturnType<typeof vi.fn>).mock.calls.length;

      // Worker resolves → goes to retry queue
      await vi.advanceTimersByTimeAsync(0);

      // New issue appears
      const issue2 = makeIssue({ id: 'issue-2', identifier: 'issue-2' });
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([issue2]);

      orchestrator.triggerRefresh();
      // Let the tick run
      await vi.advanceTimersByTimeAsync(0);

      // Should have dispatched the new issue
      expect((runAgentAttempt as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        firstCallCount,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Startup terminal cleanup
  // -----------------------------------------------------------------------

  describe('startup', () => {
    it('removes workspaces for terminal-state issues on start', async () => {
      const terminalIssue = makeIssue({ id: 'done-1', identifier: 'done-1', state: 'Shipped' });
      (mockTracker.fetchIssuesByStates as ReturnType<typeof vi.fn>).mockResolvedValue([
        terminalIssue,
      ]);

      await orchestrator.start();

      expect(mockTracker.fetchIssuesByStates).toHaveBeenCalledWith(['Shipped']);
      expect(removeWorkspace).toHaveBeenCalledWith(
        '/tmp/test-workspaces',
        'done-1',
        expect.any(Object),
      );
    });

    it('continues startup even if terminal cleanup fails', async () => {
      (mockTracker.fetchIssuesByStates as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('network error'),
      );

      // Should not throw
      await orchestrator.start();

      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  describe('shutdown', () => {
    it('aborts running workers and clears timers', async () => {
      const issue = makeIssue();
      let abortSignal: AbortSignal | null = null;

      (runAgentAttempt as ReturnType<typeof vi.fn>).mockImplementation(
        (opts: { signal: AbortSignal }) => {
          abortSignal = opts.signal;
          return new Promise(() => {});
        },
      );
      (mockTracker.fetchCandidateIssues as ReturnType<typeof vi.fn>).mockResolvedValue([issue]);

      await orchestrator.start();
      expect(abortSignal).not.toBeNull();

      await orchestrator.shutdown();

      expect(abortSignal!.aborted).toBe(true);
    });
  });
});
