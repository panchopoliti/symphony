import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, stat, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HooksConfig } from '../src/types.js';
import {
  sanitizeIdentifier,
  workspacePath,
  createForIssue,
  removeWorkspace,
  runHook,
  validateWorkspacePath,
} from '../src/workspace.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHooks(overrides: Partial<HooksConfig> = {}): HooksConfig {
  return {
    afterCreate: null,
    beforeRun: null,
    afterRun: null,
    beforeRemove: null,
    timeoutMs: 5000,
    ...overrides,
  };
}

let testRoot: string;

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'symphony-ws-test-'));
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// sanitizeIdentifier
// ---------------------------------------------------------------------------

describe('sanitizeIdentifier', () => {
  it('passes through safe characters', () => {
    expect(sanitizeIdentifier('ABC-123')).toBe('ABC-123');
    expect(sanitizeIdentifier('task.v2_draft')).toBe('task.v2_draft');
  });

  it('replaces special characters with underscores', () => {
    expect(sanitizeIdentifier('foo/bar')).toBe('foo_bar');
    expect(sanitizeIdentifier('hello world!')).toBe('hello_world_');
    expect(sanitizeIdentifier('a@b#c$d')).toBe('a_b_c_d');
  });

  it('replaces spaces and unicode', () => {
    // 🚀 is 2 UTF-16 code units, each replaced individually
    expect(sanitizeIdentifier('task 🚀 go')).toBe('task____go');
  });
});

// ---------------------------------------------------------------------------
// workspacePath
// ---------------------------------------------------------------------------

describe('workspacePath', () => {
  it('joins root with sanitized identifier', () => {
    expect(workspacePath('/workspace', 'ABC-123')).toBe('/workspace/ABC-123');
  });

  it('sanitizes identifier in path', () => {
    expect(workspacePath('/workspace', 'foo/bar')).toBe('/workspace/foo_bar');
  });
});

// ---------------------------------------------------------------------------
// validateWorkspacePath
// ---------------------------------------------------------------------------

describe('validateWorkspacePath', () => {
  it('accepts path inside root', () => {
    expect(() =>
      validateWorkspacePath('/workspace', '/workspace/issue-1'),
    ).not.toThrow();
  });

  it('rejects path outside root (traversal)', () => {
    expect(() =>
      validateWorkspacePath('/workspace', '/workspace/../etc/passwd'),
    ).toThrow(/outside workspace root/);
  });

  it('rejects completely unrelated path', () => {
    expect(() =>
      validateWorkspacePath('/workspace', '/tmp/evil'),
    ).toThrow(/outside workspace root/);
  });

  it('rejects path that is a prefix but not a child directory', () => {
    // /workspace-evil is not inside /workspace
    expect(() =>
      validateWorkspacePath('/workspace', '/workspace-evil/data'),
    ).toThrow(/outside workspace root/);
  });
});

// ---------------------------------------------------------------------------
// createForIssue
// ---------------------------------------------------------------------------

describe('createForIssue', () => {
  it('creates a new directory and returns createdNow=true', async () => {
    const result = await createForIssue(testRoot, 'ISSUE-1', makeHooks());
    expect(result.createdNow).toBe(true);
    expect(result.path).toBe(join(testRoot, 'ISSUE-1'));

    const s = await stat(result.path);
    expect(s.isDirectory()).toBe(true);
  });

  it('reuses existing directory and returns createdNow=false', async () => {
    // First call creates
    await createForIssue(testRoot, 'ISSUE-2', makeHooks());
    // Second call reuses
    const result = await createForIssue(testRoot, 'ISSUE-2', makeHooks());
    expect(result.createdNow).toBe(false);
  });

  it('runs afterCreate hook only on new directories', async () => {
    const markerFile = 'hook-ran.txt';
    const hooks = makeHooks({
      afterCreate: `echo "created" > ${markerFile}`,
    });

    // First call — hook should run
    const result = await createForIssue(testRoot, 'ISSUE-3', hooks);
    const content = await readFile(join(result.path, markerFile), 'utf-8');
    expect(content.trim()).toBe('created');

    // Second call — hook should NOT run (remove marker first)
    await rm(join(result.path, markerFile));
    await createForIssue(testRoot, 'ISSUE-3', hooks);
    // marker should not exist since hook didn't run
    await expect(stat(join(result.path, markerFile))).rejects.toThrow();
  });

  it('removes directory on afterCreate hook failure', async () => {
    const hooks = makeHooks({ afterCreate: 'exit 1' });

    await expect(
      createForIssue(testRoot, 'ISSUE-FAIL', hooks),
    ).rejects.toThrow();

    // Directory should have been cleaned up
    await expect(stat(join(testRoot, 'ISSUE-FAIL'))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// removeWorkspace
// ---------------------------------------------------------------------------

describe('removeWorkspace', () => {
  it('removes the workspace directory', async () => {
    await createForIssue(testRoot, 'ISSUE-RM', makeHooks());
    const wsPath = join(testRoot, 'ISSUE-RM');
    expect((await stat(wsPath)).isDirectory()).toBe(true);

    await removeWorkspace(testRoot, 'ISSUE-RM', makeHooks());
    await expect(stat(wsPath)).rejects.toThrow();
  });

  it('runs beforeRemove hook before deletion', async () => {
    await createForIssue(testRoot, 'ISSUE-HOOK', makeHooks());
    const wsPath = join(testRoot, 'ISSUE-HOOK');

    // Write a file so the hook can read it
    await writeFile(join(wsPath, 'data.txt'), 'important');

    const hooks = makeHooks({
      beforeRemove: 'cat data.txt > /dev/null',
    });

    // Should not throw — hook runs then directory is removed
    await removeWorkspace(testRoot, 'ISSUE-HOOK', hooks);
    await expect(stat(wsPath)).rejects.toThrow();
  });

  it('ignores beforeRemove hook failure', async () => {
    await createForIssue(testRoot, 'ISSUE-HOOKFAIL', makeHooks());

    const hooks = makeHooks({ beforeRemove: 'exit 1' });

    // Should not throw despite hook failure
    await removeWorkspace(testRoot, 'ISSUE-HOOKFAIL', hooks);
    await expect(stat(join(testRoot, 'ISSUE-HOOKFAIL'))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runHook
// ---------------------------------------------------------------------------

describe('runHook', () => {
  it('executes a script and returns stdout/stderr', async () => {
    const wsPath = join(testRoot, 'hook-test');
    await createForIssue(testRoot, 'hook-test', makeHooks());

    const result = await runHook('echo hello', wsPath, 5000);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('runs with workspace as cwd', async () => {
    await createForIssue(testRoot, 'cwd-test', makeHooks());
    const wsPath = join(testRoot, 'cwd-test');

    const result = await runHook('pwd', wsPath, 5000);
    // macOS: /var is a symlink to /private/var, so resolve both
    const expected = await realpath(wsPath);
    expect(result.stdout.trim()).toBe(expected);
  });

  it('throws on non-zero exit code', async () => {
    await createForIssue(testRoot, 'exit-test', makeHooks());
    const wsPath = join(testRoot, 'exit-test');

    await expect(runHook('exit 42', wsPath, 5000)).rejects.toThrow();
  });

  it('enforces timeout', async () => {
    await createForIssue(testRoot, 'timeout-test', makeHooks());
    const wsPath = join(testRoot, 'timeout-test');

    await expect(
      runHook('sleep 30', wsPath, 200),
    ).rejects.toThrow();
  }, 10000);
});
