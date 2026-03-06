import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { parseConfig, validateConfig } from '../src/config.js';
import { loadWorkflow, WorkflowError } from '../src/workflow.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

// ---------------------------------------------------------------------------
// loadWorkflow
// ---------------------------------------------------------------------------

describe('loadWorkflow', () => {
  it('parses a valid WORKFLOW.md with config + prompt template', () => {
    const wf = loadWorkflow(join(FIXTURES, 'workflow-valid.md'));

    expect(wf.config).toBeDefined();
    expect((wf.config as Record<string, unknown>).tracker).toBeDefined();

    const tracker = (wf.config as Record<string, Record<string, unknown>>).tracker;
    expect(tracker.kind).toBe('asana');
    expect(tracker.project_id).toBe('1213541042456827');

    expect(wf.promptTemplate).toContain('{{ issue.identifier }}');
    expect(wf.promptTemplate).toContain('{{ issue.title }}');
  });

  it('parses a minimal WORKFLOW.md', () => {
    const wf = loadWorkflow(join(FIXTURES, 'workflow-minimal.md'));

    const tracker = (wf.config as Record<string, Record<string, unknown>>).tracker;
    expect(tracker.kind).toBe('asana');
    expect(wf.promptTemplate).toBe('Do the work.');
  });

  it('throws missing_workflow_file for nonexistent file', () => {
    expect(() => loadWorkflow('/nonexistent/path/WORKFLOW.md')).toThrowError(
      expect.objectContaining({
        code: 'missing_workflow_file',
      }),
    );
  });

  it('throws workflow_front_matter_not_a_map for array YAML', () => {
    expect(() => loadWorkflow(join(FIXTURES, 'workflow-invalid.md'))).toThrowError(
      expect.objectContaining({
        code: 'workflow_front_matter_not_a_map',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// parseConfig — defaults
// ---------------------------------------------------------------------------

describe('parseConfig', () => {
  describe('defaults', () => {
    it('applies all defaults when given empty config', () => {
      const config = parseConfig({});

      expect(config.tracker.kind).toBe('');
      expect(config.tracker.apiKey).toBe('');
      expect(config.tracker.activeStates).toEqual(['Ready to start', 'In Progress']);
      expect(config.tracker.terminalStates).toEqual(['Shipped']);
      expect(config.polling.intervalMs).toBe(30000);
      expect(config.workspace.root).toBe(join(tmpdir(), 'symphony_workspaces'));
      expect(config.hooks.afterCreate).toBeNull();
      expect(config.hooks.beforeRun).toBeNull();
      expect(config.hooks.afterRun).toBeNull();
      expect(config.hooks.beforeRemove).toBeNull();
      expect(config.hooks.timeoutMs).toBe(60000);
      expect(config.agent.maxConcurrentAgents).toBe(10);
      expect(config.agent.maxTurns).toBe(20);
      expect(config.agent.maxRetryBackoffMs).toBe(300000);
      expect(config.agent.maxConcurrentAgentsByState).toEqual({});
      expect(config.claude.model).toBe('claude-sonnet-4-20250514');
      expect(config.server.port).toBeNull();
    });

    it('applies custom values from valid workflow', () => {
      const wf = loadWorkflow(join(FIXTURES, 'workflow-valid.md'));
      const config = parseConfig(wf.config);

      expect(config.tracker.kind).toBe('asana');
      expect(config.tracker.endpoint).toBe('https://app.asana.com/api/1.0');
      expect(config.tracker.projectId).toBe('1213541042456827');
      expect(config.tracker.activeStates).toEqual(['Ready to start', 'In Progress']);
      expect(config.tracker.terminalStates).toEqual(['Shipped']);
      expect(config.polling.intervalMs).toBe(15000);
      expect(config.hooks.afterCreate).toContain('echo "workspace created"');
      expect(config.hooks.timeoutMs).toBe(30000);
      expect(config.agent.maxConcurrentAgents).toBe(5);
      expect(config.agent.maxTurns).toBe(20);
      expect(config.agent.maxRetryBackoffMs).toBe(120000);
      expect(config.claude.model).toBe('claude-sonnet-4-20250514');
      expect(config.server.port).toBe(4000);
    });
  });

  describe('env var resolution', () => {
    const ENV_KEY = 'SYMPHONY_TEST_API_KEY';

    beforeEach(() => {
      process.env[ENV_KEY] = 'secret-token-123';
    });

    afterEach(() => {
      delete process.env[ENV_KEY];
    });

    it('resolves $VAR_NAME from process.env', () => {
      const config = parseConfig({
        tracker: { kind: 'asana', api_key: `$${ENV_KEY}`, project_id: '123' },
      });
      expect(config.tracker.apiKey).toBe('secret-token-123');
    });

    it('treats unset env var as empty string', () => {
      const config = parseConfig({
        tracker: { kind: 'asana', api_key: '$NONEXISTENT_VAR_12345', project_id: '123' },
      });
      expect(config.tracker.apiKey).toBe('');
    });

    it('treats empty env var as missing', () => {
      process.env['SYMPHONY_EMPTY_VAR'] = '';
      const config = parseConfig({
        tracker: { kind: 'asana', api_key: '$SYMPHONY_EMPTY_VAR', project_id: '123' },
      });
      expect(config.tracker.apiKey).toBe('');
      delete process.env['SYMPHONY_EMPTY_VAR'];
    });

    it('does not resolve non-$ strings', () => {
      const config = parseConfig({
        tracker: { kind: 'asana', api_key: 'literal-token', project_id: '123' },
      });
      expect(config.tracker.apiKey).toBe('literal-token');
    });
  });

  describe('path expansion', () => {
    it('expands ~ to home directory in workspace.root', () => {
      const config = parseConfig({
        workspace: { root: '~/my-workspaces' },
      });
      expect(config.workspace.root).toBe(join(homedir(), 'my-workspaces'));
    });

    it('expands bare ~ to home directory', () => {
      const config = parseConfig({
        workspace: { root: '~' },
      });
      expect(config.workspace.root).toBe(homedir());
    });

    it('preserves absolute paths', () => {
      const config = parseConfig({
        workspace: { root: '/tmp/symphony' },
      });
      expect(config.workspace.root).toBe('/tmp/symphony');
    });
  });

  describe('string list coercion', () => {
    it('handles comma-separated strings for active_states', () => {
      const config = parseConfig({
        tracker: { kind: 'asana', active_states: 'Ready,In Progress,Review' },
      });
      expect(config.tracker.activeStates).toEqual(['Ready', 'In Progress', 'Review']);
    });

    it('handles array for active_states', () => {
      const config = parseConfig({
        tracker: { kind: 'asana', active_states: ['Ready', 'In Progress'] },
      });
      expect(config.tracker.activeStates).toEqual(['Ready', 'In Progress']);
    });
  });

  describe('integer coercion', () => {
    it('parses string integers', () => {
      const config = parseConfig({
        polling: { interval_ms: '5000' },
        agent: { max_concurrent_agents: '3' },
      });
      expect(config.polling.intervalMs).toBe(5000);
      expect(config.agent.maxConcurrentAgents).toBe(3);
    });

    it('falls back to default for non-numeric values', () => {
      const config = parseConfig({
        polling: { interval_ms: 'abc' },
      });
      expect(config.polling.intervalMs).toBe(30000);
    });
  });

  describe('hooks timeout', () => {
    it('falls back to default for non-positive timeout', () => {
      const config = parseConfig({
        hooks: { timeout_ms: -1 },
      });
      expect(config.hooks.timeoutMs).toBe(60000);
    });

    it('falls back to default for zero timeout', () => {
      const config = parseConfig({
        hooks: { timeout_ms: 0 },
      });
      expect(config.hooks.timeoutMs).toBe(60000);
    });
  });

  describe('max_concurrent_agents_by_state', () => {
    it('normalizes state keys to lowercase', () => {
      const config = parseConfig({
        agent: {
          max_concurrent_agents_by_state: { 'In Progress': 2, 'TODO': 1 },
        },
      });
      expect(config.agent.maxConcurrentAgentsByState).toEqual({
        'in progress': 2,
        'todo': 1,
      });
    });

    it('ignores non-positive values', () => {
      const config = parseConfig({
        agent: {
          max_concurrent_agents_by_state: { 'In Progress': 0, 'Review': -1, 'Ready': 3 },
        },
      });
      expect(config.agent.maxConcurrentAgentsByState).toEqual({ 'ready': 3 });
    });
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  it('returns valid for a complete config', () => {
    const config = parseConfig({
      tracker: { kind: 'asana', api_key: 'token', project_id: '123' },
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects missing tracker.kind', () => {
    const config = parseConfig({
      tracker: { api_key: 'token', project_id: '123' },
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('tracker.kind is required');
  });

  it('rejects missing tracker.api_key', () => {
    const config = parseConfig({
      tracker: { kind: 'asana', project_id: '123' },
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('tracker.api_key is required (check env var resolution)');
  });

  it('rejects missing tracker.project_id', () => {
    const config = parseConfig({
      tracker: { kind: 'asana', api_key: 'token' },
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('tracker.project_id is required');
  });

  it('collects multiple validation errors', () => {
    const config = parseConfig({});
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
