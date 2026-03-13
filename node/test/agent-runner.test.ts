import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAgentAttempt, type AgentRunnerResult } from '../src/agent-runner.js';
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
// Helpers — mock issue, config, logger, tracker, agent
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
    polling: { intervalMs: 30000 },
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
    claude: { model: 'claude-sonnet-4-20250514', provider: 'cli' },
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

// Mock workspace module
vi.mock('../src/workspace.js', () => ({
  createForIssue: vi.fn(),
  runHook: vi.fn(),
  workspacePath: vi.fn(),
}));

import { createForIssue, runHook } from '../src/workspace.js';

describe('runAgentAttempt', () => {
  let mockTracker: TrackerAdapter;
  let mockAgent: AgentAdapter;
  let mockLogger: Logger;
  let events: AgentEvent[];
  let abortController: AbortController;

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    abortController = new AbortController();
    mockLogger = makeLogger();

    // Reset workspace mocks
    (createForIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: '/tmp/test-workspaces/issue-1',
      createdNow: true,
    });
    (runHook as ReturnType<typeof vi.fn>).mockResolvedValue({ stdout: '', stderr: '' });

    // By default, tracker says issue is still active (In Progress)
    mockTracker = {
      fetchCandidateIssues: vi.fn().mockResolvedValue([]),
      fetchIssuesByStates: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([
        makeIssue({ state: 'In Progress' }),
      ]),
    };

    // By default, agent completes successfully
    mockAgent = {
      runTurn: vi.fn().mockResolvedValue(makeTurnResult()),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates workspace, runs one turn, and completes when issue becomes non-active', async () => {
    // After first turn, issue is terminal
    (mockTracker.fetchIssueStatesByIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeIssue({ state: 'Shipped' }),
    ]);

    const result = await runAgentAttempt({
      issue: makeIssue(),
      attempt: null,
      config: makeConfig(),
      promptTemplate: 'Fix {{ issue.title }}',
      tracker: mockTracker,
      agent: mockAgent,
      logger: mockLogger,
      onUpdate: (e) => events.push(e),
      signal: abortController.signal,
    });

    expect(result.status).toBe('completed');
    expect(result.turnCount).toBe(1);
    expect(result.totalTokens.inputTokens).toBe(100);
    expect(result.totalTokens.outputTokens).toBe(50);

    // Workspace was created
    expect(createForIssue).toHaveBeenCalledOnce();

    // Agent ran one turn
    expect(mockAgent.runTurn).toHaveBeenCalledOnce();
    const callArgs = (mockAgent.runTurn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.prompt).toBe('Fix Test issue');
    expect(callArgs.workspacePath).toBe('/tmp/test-workspaces/issue-1');
  });

  it('uses rendered prompt on first turn and continuation prompt on subsequent turns', async () => {
    // First call: still active. Second call: terminal.
    (mockTracker.fetchIssueStatesByIds as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([makeIssue({ state: 'In Progress' })])
      .mockResolvedValueOnce([makeIssue({ state: 'Shipped' })]);

    await runAgentAttempt({
      issue: makeIssue(),
      attempt: 2,
      config: makeConfig(),
      promptTemplate: 'Fix {{ issue.title }}',
      tracker: mockTracker,
      agent: mockAgent,
      logger: mockLogger,
      onUpdate: (e) => events.push(e),
      signal: abortController.signal,
    });

    const calls = (mockAgent.runTurn as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);

    // First turn: rendered prompt
    expect(calls[0][0].prompt).toBe('Fix Test issue');

    // Second turn: continuation prompt
    expect(calls[1][0].prompt).toContain('Continuation guidance');
    expect(calls[1][0].prompt).toContain('turn #2 of #5');
  });

  it('respects maxTurns limit', async () => {
    const config = makeConfig({
      agent: {
        maxConcurrentAgents: 10,
        maxTurns: 3,
        maxRetryBackoffMs: 300000,
        maxConcurrentAgentsByState: {},
      },
    });

    // Issue always stays active
    (mockTracker.fetchIssueStatesByIds as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeIssue({ state: 'In Progress' }),
    ]);

    const result = await runAgentAttempt({
      issue: makeIssue(),
      attempt: null,
      config,
      promptTemplate: 'Fix {{ issue.title }}',
      tracker: mockTracker,
      agent: mockAgent,
      logger: mockLogger,
      onUpdate: (e) => events.push(e),
      signal: abortController.signal,
    });

    expect(result.status).toBe('max_turns_reached');
    expect(result.turnCount).toBe(3);
    expect(mockAgent.runTurn).toHaveBeenCalledTimes(3);
  });

  it('stops when issue state is no longer active', async () => {
    // After first turn, issue moved to terminal state
    (mockTracker.fetchIssueStatesByIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeIssue({ state: 'Shipped' }),
    ]);

    const result = await runAgentAttempt({
      issue: makeIssue(),
      attempt: null,
      config: makeConfig(),
      promptTemplate: 'Fix it',
      tracker: mockTracker,
      agent: mockAgent,
      logger: mockLogger,
      onUpdate: (e) => events.push(e),
      signal: abortController.signal,
    });

    expect(result.status).toBe('completed');
    expect(result.turnCount).toBe(1);
  });

  it('stops when tracker returns no matching issue after refresh', async () => {
    (mockTracker.fetchIssueStatesByIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const result = await runAgentAttempt({
      issue: makeIssue(),
      attempt: null,
      config: makeConfig(),
      promptTemplate: 'Fix it',
      tracker: mockTracker,
      agent: mockAgent,
      logger: mockLogger,
      onUpdate: (e) => events.push(e),
      signal: abortController.signal,
    });

    expect(result.status).toBe('completed');
    expect(result.turnCount).toBe(1);
  });

  it('returns failed when agent turn fails', async () => {
    (mockAgent.runTurn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeTurnResult({ status: 'failed', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    );

    const result = await runAgentAttempt({
      issue: makeIssue(),
      attempt: null,
      config: makeConfig(),
      promptTemplate: 'Fix it',
      tracker: mockTracker,
      agent: mockAgent,
      logger: mockLogger,
      onUpdate: (e) => events.push(e),
      signal: abortController.signal,
    });

    expect(result.status).toBe('failed');
    expect(result.turnCount).toBe(1);
    expect(result.totalTokens.totalTokens).toBe(15);
    // Should NOT re-fetch issue state after failure
    expect(mockTracker.fetchIssueStatesByIds).not.toHaveBeenCalled();
  });

  it('returns cancelled when agent turn is cancelled', async () => {
    (mockAgent.runTurn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeTurnResult({ status: 'cancelled', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }),
    );

    const result = await runAgentAttempt({
      issue: makeIssue(),
      attempt: null,
      config: makeConfig(),
      promptTemplate: 'Fix it',
      tracker: mockTracker,
      agent: mockAgent,
      logger: mockLogger,
      onUpdate: (e) => events.push(e),
      signal: abortController.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(result.turnCount).toBe(1);
  });

  it('returns cancelled when signal is aborted before first turn', async () => {
    abortController.abort();

    const result = await runAgentAttempt({
      issue: makeIssue(),
      attempt: null,
      config: makeConfig(),
      promptTemplate: 'Fix it',
      tracker: mockTracker,
      agent: mockAgent,
      logger: mockLogger,
      onUpdate: (e) => events.push(e),
      signal: abortController.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(result.turnCount).toBe(0);
    expect(mockAgent.runTurn).not.toHaveBeenCalled();
  });

  it('runs beforeRun hook and aborts on failure', async () => {
    const config = makeConfig({
      hooks: {
        afterCreate: null,
        beforeRun: 'echo setup',
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 60000,
      },
    });

    (runHook as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('hook failed'));

    await expect(
      runAgentAttempt({
        issue: makeIssue(),
        attempt: null,
        config,
        promptTemplate: 'Fix it',
        tracker: mockTracker,
        agent: mockAgent,
        logger: mockLogger,
        onUpdate: (e) => events.push(e),
        signal: abortController.signal,
      }),
    ).rejects.toThrow('hook failed');

    // Agent should NOT have been called
    expect(mockAgent.runTurn).not.toHaveBeenCalled();
  });

  it('runs afterRun hook on success and ignores failure', async () => {
    const config = makeConfig({
      hooks: {
        afterCreate: null,
        beforeRun: null,
        afterRun: 'echo cleanup',
        beforeRemove: null,
        timeoutMs: 60000,
      },
    });

    // Issue becomes terminal after first turn
    (mockTracker.fetchIssueStatesByIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeIssue({ state: 'Shipped' }),
    ]);

    // afterRun hook fails
    (runHook as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('afterRun failed'));

    // Should NOT throw despite afterRun failure
    const result = await runAgentAttempt({
      issue: makeIssue(),
      attempt: null,
      config,
      promptTemplate: 'Fix it',
      tracker: mockTracker,
      agent: mockAgent,
      logger: mockLogger,
      onUpdate: (e) => events.push(e),
      signal: abortController.signal,
    });

    expect(result.status).toBe('completed');
    expect(runHook).toHaveBeenCalledWith('echo cleanup', '/tmp/test-workspaces/issue-1', 60000);
  });

  it('accumulates token usage across multiple turns', async () => {
    (mockAgent.runTurn as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeTurnResult({ usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } }))
      .mockResolvedValueOnce(makeTurnResult({ usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 } }));

    (mockTracker.fetchIssueStatesByIds as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([makeIssue({ state: 'In Progress' })])
      .mockResolvedValueOnce([makeIssue({ state: 'Shipped' })]);

    const result = await runAgentAttempt({
      issue: makeIssue(),
      attempt: null,
      config: makeConfig(),
      promptTemplate: 'Fix it',
      tracker: mockTracker,
      agent: mockAgent,
      logger: mockLogger,
      onUpdate: (e) => events.push(e),
      signal: abortController.signal,
    });

    expect(result.turnCount).toBe(2);
    expect(result.totalTokens.inputTokens).toBe(300);
    expect(result.totalTokens.outputTokens).toBe(150);
    expect(result.totalTokens.totalTokens).toBe(450);
  });

  it('forwards agent events via onUpdate callback', async () => {
    const emittedEvents: AgentEvent[] = [];

    const fakeEvent: AgentEvent = {
      event: 'turn_completed',
      timestamp: new Date(),
      sessionId: 'sess-1',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      payload: {},
    };

    (mockAgent.runTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(async (opts: { onMessage: (e: AgentEvent) => void }) => {
      opts.onMessage(fakeEvent);
      return makeTurnResult();
    });

    (mockTracker.fetchIssueStatesByIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeIssue({ state: 'Shipped' }),
    ]);

    await runAgentAttempt({
      issue: makeIssue(),
      attempt: null,
      config: makeConfig(),
      promptTemplate: 'Fix it',
      tracker: mockTracker,
      agent: mockAgent,
      logger: mockLogger,
      onUpdate: (e) => emittedEvents.push(e),
      signal: abortController.signal,
    });

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toBe(fakeEvent);
  });

  it('runs afterRun hook even when turns fail', async () => {
    const config = makeConfig({
      hooks: {
        afterCreate: null,
        beforeRun: null,
        afterRun: 'echo cleanup',
        beforeRemove: null,
        timeoutMs: 60000,
      },
    });

    (mockAgent.runTurn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeTurnResult({ status: 'failed' }),
    );

    const result = await runAgentAttempt({
      issue: makeIssue(),
      attempt: null,
      config,
      promptTemplate: 'Fix it',
      tracker: mockTracker,
      agent: mockAgent,
      logger: mockLogger,
      onUpdate: (e) => events.push(e),
      signal: abortController.signal,
    });

    expect(result.status).toBe('failed');
    // afterRun should still be called (in finally block)
    expect(runHook).toHaveBeenCalledWith('echo cleanup', '/tmp/test-workspaces/issue-1', 60000);
  });

  it('state comparison is case-insensitive', async () => {
    // Tracker returns "in progress" (lowercase) which should match "In Progress" in config
    (mockTracker.fetchIssueStatesByIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeIssue({ state: 'in progress' }),
    ]);
    // Second call returns terminal
    (mockTracker.fetchIssueStatesByIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeIssue({ state: 'Shipped' }),
    ]);

    const result = await runAgentAttempt({
      issue: makeIssue(),
      attempt: null,
      config: makeConfig(),
      promptTemplate: 'Fix it',
      tracker: mockTracker,
      agent: mockAgent,
      logger: mockLogger,
      onUpdate: (e) => events.push(e),
      signal: abortController.signal,
    });

    // Should have run 2 turns since "in progress" matches "In Progress"
    expect(result.turnCount).toBe(2);
  });
});
