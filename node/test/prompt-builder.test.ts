import { describe, it, expect } from 'vitest';
import { renderPrompt } from '../src/prompt-builder.js';
import type { Issue } from '../src/types.js';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: '12345',
    identifier: '12345',
    title: 'Fix the login bug',
    description: 'Users cannot log in with SSO.',
    priority: 1,
    state: 'In Progress',
    branchName: 'fix-login-bug',
    url: 'https://app.asana.com/0/project/12345',
    labels: ['bug', 'critical'],
    blockedBy: [],
    createdAt: new Date('2026-01-15T10:00:00Z'),
    updatedAt: new Date('2026-02-20T14:30:00Z'),
    ...overrides,
  };
}

describe('renderPrompt', () => {
  it('renders basic issue fields', () => {
    const issue = makeIssue();
    const result = renderPrompt(
      'Task {{ issue.identifier }}: {{ issue.title }}',
      issue,
      null,
    );
    expect(result).toBe('Task 12345: Fix the login bug');
  });

  it('renders snake_case issue fields', () => {
    const issue = makeIssue();
    const result = renderPrompt(
      'Branch: {{ issue.branch_name }}',
      issue,
      null,
    );
    expect(result).toBe('Branch: fix-login-bug');
  });

  it('renders camelCase issue fields', () => {
    const issue = makeIssue();
    const result = renderPrompt(
      'Branch: {{ issue.branchName }}',
      issue,
      null,
    );
    expect(result).toBe('Branch: fix-login-bug');
  });

  it('renders attempt variable when null', () => {
    const issue = makeIssue();
    const result = renderPrompt(
      'Attempt: {{ attempt }}',
      issue,
      null,
    );
    expect(result).toBe('Attempt: ');
  });

  it('renders attempt variable when a number', () => {
    const issue = makeIssue();
    const result = renderPrompt(
      'Attempt: {{ attempt }}',
      issue,
      3,
    );
    expect(result).toBe('Attempt: 3');
  });

  it('handles conditional blocks with attempt', () => {
    const issue = makeIssue();
    const template = '{% if attempt %}Retry #{{ attempt }}{% endif %}Done';

    expect(renderPrompt(template, issue, null)).toBe('Done');
    expect(renderPrompt(template, issue, 2)).toBe('Retry #2Done');
  });

  it('returns fallback for empty template', () => {
    const issue = makeIssue();
    expect(renderPrompt('', issue, null)).toBe(
      'You are working on an issue from Asana.',
    );
  });

  it('returns fallback for whitespace-only template', () => {
    const issue = makeIssue();
    expect(renderPrompt('   \n\t  ', issue, null)).toBe(
      'You are working on an issue from Asana.',
    );
  });

  it('throws on unknown variables in strict mode', () => {
    const issue = makeIssue();
    expect(() =>
      renderPrompt('{{ nonexistent_var }}', issue, null),
    ).toThrow('template_render_error');
  });

  it('throws on unknown issue fields in strict mode', () => {
    const issue = makeIssue();
    expect(() =>
      renderPrompt('{{ issue.nonexistent_field }}', issue, null),
    ).toThrow('template_render_error');
  });

  it('iterates over labels array', () => {
    const issue = makeIssue({ labels: ['bug', 'critical', 'p0'] });
    const template =
      '{% for label in issue.labels %}{{ label }},{% endfor %}';
    const result = renderPrompt(template, issue, null);
    expect(result).toBe('bug,critical,p0,');
  });

  it('iterates over blockedBy array', () => {
    const issue = makeIssue({
      blockedBy: [
        { id: '111', identifier: '111', state: 'In Progress' },
        { id: '222', identifier: '222', state: 'Done' },
      ],
    });
    const template =
      '{% for blocker in issue.blocked_by %}{{ blocker.identifier }}:{{ blocker.state }};{% endfor %}';
    const result = renderPrompt(template, issue, null);
    expect(result).toBe('111:In Progress;222:Done;');
  });

  it('renders dates as ISO strings', () => {
    const issue = makeIssue({
      createdAt: new Date('2026-01-15T10:00:00.000Z'),
    });
    const result = renderPrompt(
      'Created: {{ issue.created_at }}',
      issue,
      null,
    );
    expect(result).toBe('Created: 2026-01-15T10:00:00.000Z');
  });

  it('handles null description with conditional', () => {
    const issue = makeIssue({ description: null });
    const template =
      '{% if issue.description %}Desc: {{ issue.description }}{% else %}No description{% endif %}';
    const result = renderPrompt(template, issue, null);
    expect(result).toBe('No description');
  });

  it('renders a full realistic prompt template', () => {
    const issue = makeIssue();
    const template = `You are working on Asana task \`{{ issue.identifier }}\`

**Title:** {{ issue.title }}
**Status:** {{ issue.state }}
**URL:** {{ issue.url }}

{% if issue.description %}**Description:**
{{ issue.description }}{% endif %}

{% if attempt %}This is continuation attempt #{{ attempt }}.{% endif %}`;

    const result = renderPrompt(template, issue, null);
    expect(result).toContain('Asana task `12345`');
    expect(result).toContain('**Title:** Fix the login bug');
    expect(result).toContain('**Status:** In Progress');
    expect(result).toContain('Users cannot log in with SSO.');
    expect(result).not.toContain('continuation attempt');
  });

  it('renders a full realistic prompt template with attempt', () => {
    const issue = makeIssue();
    const template = `Task {{ issue.identifier }}
{% if attempt %}Retry #{{ attempt }}{% endif %}`;

    const result = renderPrompt(template, issue, 2);
    expect(result).toContain('Task 12345');
    expect(result).toContain('Retry #2');
  });
});
