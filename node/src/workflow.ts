// Symphony Node.js — Workflow Loader
// Parses WORKFLOW.md (YAML front matter + Markdown body) and watches for changes.

import { readFileSync } from 'node:fs';
import matter from 'gray-matter';
import { watch } from 'chokidar';
import type { WorkflowDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class WorkflowError extends Error {
  constructor(
    public readonly code:
      | 'missing_workflow_file'
      | 'workflow_parse_error'
      | 'workflow_front_matter_not_a_map',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

// ---------------------------------------------------------------------------
// loadWorkflow — reads file, parses YAML front matter + Markdown body
// ---------------------------------------------------------------------------

export function loadWorkflow(filePath: string): WorkflowDefinition {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkflowError(
      'missing_workflow_file',
      `Cannot read workflow file: ${filePath} — ${msg}`,
    );
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkflowError(
      'workflow_parse_error',
      `Failed to parse YAML front matter in ${filePath} — ${msg}`,
    );
  }

  const config = parsed.data;

  // Front matter must be a plain object (map), not an array or primitive
  if (
    config === null ||
    config === undefined ||
    typeof config !== 'object' ||
    Array.isArray(config)
  ) {
    throw new WorkflowError(
      'workflow_front_matter_not_a_map',
      `YAML front matter must be a map/object, got ${Array.isArray(config) ? 'array' : typeof config}`,
    );
  }

  const promptTemplate = parsed.content.trim();

  return { config: config as Record<string, unknown>, promptTemplate };
}

// ---------------------------------------------------------------------------
// watchWorkflow — watches file for changes, calls onChange with new definition
// ---------------------------------------------------------------------------

export function watchWorkflow(
  filePath: string,
  onChange: (wf: WorkflowDefinition) => void,
): void {
  let lastGood: WorkflowDefinition | null = null;

  // Try initial load
  try {
    lastGood = loadWorkflow(filePath);
  } catch {
    // If initial load fails, we still watch — the file may be created/fixed later
  }

  const watcher = watch(filePath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on('change', () => {
    try {
      const wf = loadWorkflow(filePath);
      lastGood = wf;
      onChange(wf);
    } catch {
      // Keep last-known-good on parse errors — don't call onChange
    }
  });

  watcher.on('add', () => {
    try {
      const wf = loadWorkflow(filePath);
      lastGood = wf;
      onChange(wf);
    } catch {
      // ignore
    }
  });
}
