// Symphony Node.js — Prompt Builder
// Renders WORKFLOW.md prompt templates with issue + attempt variables using LiquidJS
// Based on SPEC.md Section 12 (Prompt Construction)

import { Liquid } from 'liquidjs';
import type { Issue } from './types.js';

const FALLBACK_PROMPT = 'You are working on an issue from Asana.';

/**
 * Convert a camelCase string to snake_case.
 */
function toSnakeCase(str: string): string {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * Convert an Issue to a template-friendly plain object with both
 * camelCase and snake_case keys. Dates are converted to ISO strings.
 * Arrays are preserved for iteration.
 */
function issueToTemplateObject(issue: Issue): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(issue)) {
    const converted = value instanceof Date ? value.toISOString() : value;
    // Add both camelCase and snake_case versions
    obj[key] = converted;
    const snakeKey = toSnakeCase(key);
    if (snakeKey !== key) {
      obj[snakeKey] = converted;
    }
  }

  // Ensure blockedBy array items are also plain objects with snake_case keys
  if (Array.isArray(issue.blockedBy)) {
    const converted = issue.blockedBy.map((b) => {
      const item: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b)) {
        item[k] = v;
        const sk = toSnakeCase(k);
        if (sk !== k) item[sk] = v;
      }
      return item;
    });
    obj['blockedBy'] = converted;
    obj['blocked_by'] = converted;
  }

  return obj;
}

/**
 * Render a prompt template with issue and attempt variables.
 *
 * Uses LiquidJS in strict mode (strict variables + strict filters).
 * Template variables:
 *   - `issue.*` — all Issue fields, accessible in both camelCase and snake_case
 *   - `attempt` — number (retry count) or null (first run)
 *
 * @throws Error with code `template_render_error` on unknown variables/filters
 */
export function renderPrompt(
  template: string,
  issue: Issue,
  attempt: number | null,
): string {
  const trimmed = template.trim();
  if (trimmed === '') {
    return FALLBACK_PROMPT;
  }

  const engine = new Liquid({
    strictVariables: true,
    strictFilters: true,
  });

  const context = {
    issue: issueToTemplateObject(issue),
    attempt,
  };

  try {
    return engine.parseAndRenderSync(trimmed, context);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const error = new Error(`template_render_error: ${message}`);
    error.name = 'template_render_error';
    throw error;
  }
}
