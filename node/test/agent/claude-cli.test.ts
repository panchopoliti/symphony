// Tests for ClaudeCodeCliAgent — Claude Code CLI integration
// Mocks child_process.spawn to test the CLI agent without running the real claude binary.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { AgentEvent, ServiceConfig } from '../../src/types.js';
import { ActivityLogStore } from '../../src/activity-log.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { ClaudeCodeCliAgent } from '../../src/agent/claude-cli.js';

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: { end: () => void };
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.stdin = { end: vi.fn() };
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

function mockConfig(): ServiceConfig {
  return {
    tracker: {
      kind: 'asana',
      endpoint: 'https://app.asana.com/api/1.0',
      apiKey: 'test-key',
      projectId: '123',
      activeStates: ['In Progress'],
      terminalStates: ['Shipped'],
    },
    polling: { intervalMs: 30000 },
    workspace: { root: '/tmp/workspaces' },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60000,
    },
    agent: {
      maxConcurrentAgents: 10,
      maxTurns: 20,
      maxRetryBackoffMs: 300000,
      maxConcurrentAgentsByState: {},
    },
    claude: { model: 'claude-sonnet-4-20250514', provider: 'cli' },
    server: { port: null },
  };
}

describe('ClaudeCodeCliAgent', () => {
  let agent: ClaudeCodeCliAgent;
  let activityLog: ActivityLogStore;
  let events: AgentEvent[];

  beforeEach(() => {
    activityLog = new ActivityLogStore();
    agent = new ClaudeCodeCliAgent({ model: 'claude-sonnet-4-20250514', activityLog });
    events = [];
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spawns claude with correct arguments', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const resultPromise = agent.runTurn({
      prompt: 'Fix the bug',
      workspacePath: '/tmp/workspaces/task-123',
      config: mockConfig(),
      onMessage: (e) => events.push(e),
      signal: new AbortController().signal,
    });

    // Emit a result event and close
    proc.stdout.push(JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 100, output_tokens: 50 },
      result: 'Done',
    }) + '\n');
    proc.stdout.push(null);
    proc.emit('close', 0);

    const result = await resultPromise;

    expect(spawnMock).toHaveBeenCalledOnce();
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-20250514');
    expect(args).toContain('--max-turns');
    expect(args).toContain('50');
    expect(args).toContain('Fix the bug'); // prompt is positional arg
    expect(opts.cwd).toBe('/tmp/workspaces/task-123');

    expect(result.status).toBe('completed');
  });

  it('parses stream-json output and logs activity', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const resultPromise = agent.runTurn({
      prompt: 'Do task',
      workspacePath: '/tmp/workspaces/task-456',
      config: mockConfig(),
      onMessage: (e) => events.push(e),
      signal: new AbortController().signal,
    });

    // Send assistant message with text and tool_use
    proc.stdout.push(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me read the file' },
          { type: 'tool_use', name: 'readFile', input: { path: 'src/index.ts' } },
        ],
      },
    }) + '\n');

    // Send result
    proc.stdout.push(JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 200, output_tokens: 100 },
      result: 'Task complete',
    }) + '\n');
    proc.stdout.push(null);

    // Allow readline to process before close
    await new Promise((r) => setTimeout(r, 50));
    proc.emit('close', 0);

    const result = await resultPromise;

    expect(result.status).toBe('completed');
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(100);
    expect(result.usage.totalTokens).toBe(300);
    expect(result.stepCount).toBe(1); // One tool_use

    // Check activity log
    const log = activityLog.getLog('task-456');
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log[0].type).toBe('text');
    expect(log[0].content).toBe('Let me read the file');
    expect(log[1].type).toBe('tool_call');
    expect(log[1].content).toContain('readFile');
  });

  it('emits session_started and turn_completed events', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const resultPromise = agent.runTurn({
      prompt: 'Do task',
      workspacePath: '/tmp/workspaces/task-789',
      config: mockConfig(),
      onMessage: (e) => events.push(e),
      signal: new AbortController().signal,
    });

    proc.stdout.push(JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 50, output_tokens: 25 },
    }) + '\n');
    proc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 50));
    proc.emit('close', 0);

    await resultPromise;

    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('session_started');
    expect(events[0].payload).toHaveProperty('provider', 'cli');
    expect(events[1].event).toBe('turn_completed');
    expect(events[1].usage).toEqual({
      inputTokens: 50,
      outputTokens: 25,
      totalTokens: 75,
    });
  });

  it('returns failed status on non-zero exit code', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const resultPromise = agent.runTurn({
      prompt: 'Do task',
      workspacePath: '/tmp/workspaces/task-err',
      config: mockConfig(),
      onMessage: (e) => events.push(e),
      signal: new AbortController().signal,
    });

    proc.stderr.push('Error: something went wrong');
    proc.stderr.push(null);
    proc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 50));
    proc.emit('close', 1);

    const result = await resultPromise;

    expect(result.status).toBe('failed');
    expect(result.error).toContain('something went wrong');
    expect(events.some((e) => e.event === 'turn_failed')).toBe(true);
  });

  it('kills process and returns cancelled on abort signal', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const controller = new AbortController();

    const resultPromise = agent.runTurn({
      prompt: 'Do task',
      workspacePath: '/tmp/workspaces/task-abort',
      config: mockConfig(),
      onMessage: (e) => events.push(e),
      signal: controller.signal,
    });

    // Abort the signal
    controller.abort();

    // Let the process close
    proc.stdout.push(null);
    proc.emit('close', null);

    const result = await resultPromise;

    expect(result.status).toBe('cancelled');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(events.some((e) => e.event === 'turn_cancelled')).toBe(true);
  });

  it('handles process error event', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const resultPromise = agent.runTurn({
      prompt: 'Do task',
      workspacePath: '/tmp/workspaces/task-proc-err',
      config: mockConfig(),
      onMessage: (e) => events.push(e),
      signal: new AbortController().signal,
    });

    proc.emit('error', new Error('spawn ENOENT'));

    const result = await resultPromise;

    expect(result.status).toBe('failed');
    expect(result.error).toContain('spawn ENOENT');
  });

  it('uses default model when none specified', () => {
    const defaultAgent = new ClaudeCodeCliAgent();
    expect(defaultAgent).toBeInstanceOf(ClaudeCodeCliAgent);
  });
});
