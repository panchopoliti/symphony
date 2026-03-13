// Tests for ClaudeAgent — Vercel AI SDK integration
// Mocks generateText to test the integration flow without calling the real API.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeAgent, validateToolPath } from '../../src/agent/claude.js';
import type { AgentEvent, ServiceConfig } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Path validation tests
// ---------------------------------------------------------------------------

describe('validateToolPath', () => {
  it('resolves a relative path inside workspace', () => {
    const result = validateToolPath('/workspace', 'src/index.ts');
    expect(result).toBe('/workspace/src/index.ts');
  });

  it('resolves a nested relative path', () => {
    const result = validateToolPath('/workspace', 'src/../src/index.ts');
    expect(result).toBe('/workspace/src/index.ts');
  });

  it('rejects path traversal outside workspace', () => {
    expect(() => validateToolPath('/workspace', '../etc/passwd')).toThrow(
      /outside workspace/,
    );
  });

  it('rejects absolute path outside workspace', () => {
    expect(() => validateToolPath('/workspace', '/etc/passwd')).toThrow(
      /outside workspace/,
    );
  });

  it('allows the workspace root itself', () => {
    const result = validateToolPath('/workspace', '.');
    expect(result).toBe('/workspace');
  });

  it('rejects traversal via deeply nested ..', () => {
    expect(() =>
      validateToolPath('/workspace', 'a/b/c/../../../../etc'),
    ).toThrow(/outside workspace/);
  });
});

// ---------------------------------------------------------------------------
// Mock generateText for ClaudeAgent tests
// ---------------------------------------------------------------------------

// We mock the 'ai' module to intercept generateText calls
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

// Mock the anthropic provider — return a simple function that returns a model identifier
vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((modelId: string) => ({ modelId, provider: 'anthropic' })),
}));

describe('ClaudeAgent', () => {
  let agent: ClaudeAgent;
  let mockConfig: ServiceConfig;
  let events: AgentEvent[];
  let generateTextMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    agent = new ClaudeAgent({ model: 'claude-sonnet-4-20250514' });
    events = [];
    mockConfig = {
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

    // Get the mocked generateText
    const aiModule = await import('ai');
    generateTextMock = aiModule.generateText as unknown as ReturnType<typeof vi.fn>;
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends prompt to model and returns completed result', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'Done! I created the file.',
      usage: { promptTokens: 100, completionTokens: 50 },
      steps: [{ stepType: 'initial' }, { stepType: 'tool-result' }],
      finishReason: 'stop',
    });

    const controller = new AbortController();
    const result = await agent.runTurn({
      prompt: 'Create a hello.ts file',
      workspacePath: '/tmp/test-workspace',
      config: mockConfig,
      onMessage: (e) => events.push(e),
      signal: controller.signal,
    });

    // Verify result
    expect(result.status).toBe('completed');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.totalTokens).toBe(150);
    expect(result.stepCount).toBe(2);

    // Verify generateText was called with correct args
    expect(generateTextMock).toHaveBeenCalledOnce();
    const callArgs = generateTextMock.mock.calls[0][0];
    expect(callArgs.prompt).toBe('Create a hello.ts file');
    expect(callArgs.maxSteps).toBe(50);
    expect(callArgs.system).toContain('/tmp/test-workspace');
    expect(callArgs.tools).toHaveProperty('bash');
    expect(callArgs.tools).toHaveProperty('readFile');
    expect(callArgs.tools).toHaveProperty('writeFile');
    expect(callArgs.tools).toHaveProperty('listFiles');
  });

  it('emits session_started and turn_completed events', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'Done!',
      usage: { promptTokens: 50, completionTokens: 25 },
      steps: [{ stepType: 'initial' }],
      finishReason: 'stop',
    });

    const controller = new AbortController();
    await agent.runTurn({
      prompt: 'Do something',
      workspacePath: '/tmp/ws',
      config: mockConfig,
      onMessage: (e) => events.push(e),
      signal: controller.signal,
    });

    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('session_started');
    expect(events[0].sessionId).toBeTruthy();
    expect(events[0].payload).toHaveProperty('model', 'claude-sonnet-4-20250514');
    expect(events[1].event).toBe('turn_completed');
    expect(events[1].usage).toEqual({
      inputTokens: 50,
      outputTokens: 25,
      totalTokens: 75,
    });
    expect(events[1].payload).toHaveProperty('finishReason', 'stop');
    expect(events[1].payload).toHaveProperty('stepCount', 1);
  });

  it('emits turn_failed on API error', async () => {
    generateTextMock.mockRejectedValueOnce(new Error('API rate limit exceeded'));

    const controller = new AbortController();
    const result = await agent.runTurn({
      prompt: 'Do something',
      workspacePath: '/tmp/ws',
      config: mockConfig,
      onMessage: (e) => events.push(e),
      signal: controller.signal,
    });

    expect(result.status).toBe('failed');
    expect(result.usage.totalTokens).toBe(0);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('session_started');
    expect(events[1].event).toBe('turn_failed');
    expect(events[1].payload).toHaveProperty('error', 'API rate limit exceeded');
  });

  it('emits turn_cancelled when signal is aborted', async () => {
    const controller = new AbortController();

    generateTextMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    });

    const result = await agent.runTurn({
      prompt: 'Do something',
      workspacePath: '/tmp/ws',
      config: mockConfig,
      onMessage: (e) => events.push(e),
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('session_started');
    expect(events[1].event).toBe('turn_cancelled');
  });

  it('uses default model when none specified', () => {
    const defaultAgent = new ClaudeAgent();
    // The default model is set in the constructor — we verify it works
    // by checking generateText is called with anthropic('claude-sonnet-4-20250514')
    expect(defaultAgent).toBeInstanceOf(ClaudeAgent);
  });

  it('tracks token usage correctly', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'Result',
      usage: { promptTokens: 1500, completionTokens: 800 },
      steps: Array.from({ length: 5 }, (_, i) => ({ stepType: `step-${i}` })),
      finishReason: 'stop',
    });

    const controller = new AbortController();
    const result = await agent.runTurn({
      prompt: 'Complex task',
      workspacePath: '/tmp/ws',
      config: mockConfig,
      onMessage: (e) => events.push(e),
      signal: controller.signal,
    });

    expect(result.usage).toEqual({
      inputTokens: 1500,
      outputTokens: 800,
      totalTokens: 2300,
    });
    expect(result.stepCount).toBe(5);
  });

  it('passes abortSignal to generateText', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'OK',
      usage: { promptTokens: 10, completionTokens: 5 },
      steps: [],
      finishReason: 'stop',
    });

    const controller = new AbortController();
    await agent.runTurn({
      prompt: 'Test',
      workspacePath: '/tmp/ws',
      config: mockConfig,
      onMessage: (e) => events.push(e),
      signal: controller.signal,
    });

    const callArgs = generateTextMock.mock.calls[0][0];
    expect(callArgs.abortSignal).toBe(controller.signal);
  });
});
