// Symphony Node.js — Workspace Manager
// Per-issue workspace directories with lifecycle hooks and path safety.

import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { HooksConfig } from './types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Sanitize identifier — only [A-Za-z0-9._-] allowed
// ---------------------------------------------------------------------------

export function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ---------------------------------------------------------------------------
// Compute workspace path
// ---------------------------------------------------------------------------

export function workspacePath(root: string, identifier: string): string {
  return join(root, sanitizeIdentifier(identifier));
}

// ---------------------------------------------------------------------------
// Validate workspace path stays inside root (prevent path traversal)
// ---------------------------------------------------------------------------

export function validateWorkspacePath(workspaceRoot: string, wsPath: string): void {
  const absRoot = resolve(workspaceRoot);
  const absPath = resolve(wsPath);
  // Must be inside root — absPath must start with absRoot + separator (or equal absRoot)
  if (!absPath.startsWith(absRoot + '/') && absPath !== absRoot) {
    throw new Error(
      `Workspace path "${absPath}" is outside workspace root "${absRoot}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Run a lifecycle hook via bash -lc
// ---------------------------------------------------------------------------

export async function runHook(
  script: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('bash', ['-lc', script], {
    cwd,
    timeout: timeoutMs,
  });
  return { stdout, stderr };
}

// ---------------------------------------------------------------------------
// Create workspace for an issue
// ---------------------------------------------------------------------------

export async function createForIssue(
  root: string,
  identifier: string,
  hooks: HooksConfig,
): Promise<{ path: string; createdNow: boolean }> {
  const wsPath = workspacePath(root, identifier);
  validateWorkspacePath(root, wsPath);

  // Check if directory already exists
  let existed = false;
  try {
    const s = await stat(wsPath);
    existed = s.isDirectory();
  } catch {
    // Does not exist
  }

  if (!existed) {
    await mkdir(wsPath, { recursive: true });
  }

  const createdNow = !existed;

  // Run afterCreate hook only for newly created workspaces
  if (createdNow && hooks.afterCreate) {
    try {
      await runHook(hooks.afterCreate, wsPath, hooks.timeoutMs);
    } catch (err) {
      // afterCreate failure is fatal — remove partial directory and rethrow
      await rm(wsPath, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  return { path: wsPath, createdNow };
}

// ---------------------------------------------------------------------------
// Remove workspace for an issue
// ---------------------------------------------------------------------------

export async function removeWorkspace(
  root: string,
  identifier: string,
  hooks: HooksConfig,
): Promise<void> {
  const wsPath = workspacePath(root, identifier);
  validateWorkspacePath(root, wsPath);

  // Run beforeRemove hook (best-effort — failures are logged and ignored)
  if (hooks.beforeRemove) {
    try {
      await runHook(hooks.beforeRemove, wsPath, hooks.timeoutMs);
    } catch {
      // beforeRemove failures are logged and ignored per SPEC.md
    }
  }

  await rm(wsPath, { recursive: true, force: true });
}
