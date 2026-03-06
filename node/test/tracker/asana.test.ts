import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsanaTracker, stripEmoji, matchesState } from '../../src/tracker/asana.js';

// ---------------------------------------------------------------------------
// Helpers: mock Asana API responses
// ---------------------------------------------------------------------------

function asanaSection(gid: string, name: string) {
  return { gid, name };
}

function asanaTask(overrides: Record<string, unknown> = {}) {
  return {
    gid: '111',
    name: 'Fix login bug',
    notes: 'Users cannot login with SSO',
    completed: false,
    assignee: { name: 'Alice' },
    tags: [{ gid: 't1', name: 'Bug' }],
    dependencies: [],
    memberships: [
      {
        section: { gid: 's1', name: '🚧 In Progress' },
        project: { gid: 'proj1' },
      },
    ],
    permalink_url: 'https://app.asana.com/0/proj1/111',
    custom_fields: [],
    created_at: '2026-01-15T10:00:00.000Z',
    modified_at: '2026-03-01T14:30:00.000Z',
    ...overrides,
  };
}

function pagedResponse(data: unknown[], nextOffset: string | null = null) {
  return {
    data,
    next_page: nextOffset ? { offset: nextOffset, uri: '' } : null,
  };
}

function singleResponse(data: unknown) {
  return { data };
}

// ---------------------------------------------------------------------------
// Tests: stripEmoji
// ---------------------------------------------------------------------------

describe('stripEmoji', () => {
  it('strips leading emoji and space', () => {
    expect(stripEmoji('🚧 In Progress')).toBe('In Progress');
  });

  it('strips leading emoji without space', () => {
    expect(stripEmoji('📥Inbox')).toBe('Inbox');
  });

  it('strips multiple leading emojis', () => {
    expect(stripEmoji('🔥🚀 Urgent')).toBe('Urgent');
  });

  it('returns plain name unchanged', () => {
    expect(stripEmoji('In Progress')).toBe('In Progress');
  });

  it('handles empty string', () => {
    expect(stripEmoji('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Tests: matchesState
// ---------------------------------------------------------------------------

describe('matchesState', () => {
  it('matches after stripping emoji, case-insensitive', () => {
    expect(matchesState('🚧 In Progress', 'In Progress')).toBe(true);
    expect(matchesState('🚧 In Progress', 'in progress')).toBe(true);
  });

  it('matches plain names case-insensitively', () => {
    expect(matchesState('Ready to start', 'ready to start')).toBe(true);
  });

  it('does not match different states', () => {
    expect(matchesState('🚧 In Progress', 'Shipped')).toBe(false);
  });

  it('handles leading/trailing whitespace in configured state', () => {
    expect(matchesState('📥 Inbox', '  Inbox  ')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: AsanaTracker
// ---------------------------------------------------------------------------

describe('AsanaTracker', () => {
  let tracker: AsanaTracker;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    tracker = new AsanaTracker({
      endpoint: 'https://app.asana.com/api/1.0',
      apiKey: 'test-api-key',
      projectId: 'proj1',
      activeStates: ['Ready to start', 'In Progress'],
      terminalStates: ['Shipped'],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -- fetchCandidateIssues ------------------------------------------------

  describe('fetchCandidateIssues', () => {
    it('returns normalized issues from active sections', async () => {
      // 1st call: GET /projects/proj1/sections
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          singleResponse([
            asanaSection('s1', '📥 Inbox'),
            asanaSection('s2', '🚧 In Progress'),
            asanaSection('s3', '✅ Shipped'),
          ]),
      });

      // 2nd call: GET /sections/s2/tasks (only "In Progress" matches active states)
      const task = asanaTask();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => pagedResponse([task]),
      });

      const issues = await tracker.fetchCandidateIssues();

      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe('111');
      expect(issues[0].identifier).toBe('111');
      expect(issues[0].title).toBe('Fix login bug');
      expect(issues[0].description).toBe('Users cannot login with SSO');
      expect(issues[0].state).toBe('In Progress');
      expect(issues[0].labels).toEqual(['bug']);
      expect(issues[0].url).toBe('https://app.asana.com/0/proj1/111');
      expect(issues[0].createdAt).toEqual(new Date('2026-01-15T10:00:00.000Z'));
      expect(issues[0].updatedAt).toEqual(new Date('2026-03-01T14:30:00.000Z'));
      expect(issues[0].priority).toBeNull();
      expect(issues[0].branchName).toBeNull();
      expect(issues[0].blockedBy).toEqual([]);
    });

    it('fetches from multiple active sections', async () => {
      // Sections: Inbox matches nothing, "Ready to start" and "In Progress" match
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          singleResponse([
            asanaSection('s1', '📋 Ready to start'),
            asanaSection('s2', '🚧 In Progress'),
            asanaSection('s3', '✅ Shipped'),
          ]),
      });

      // Tasks from "Ready to start"
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          pagedResponse([
            asanaTask({ gid: '200', name: 'Task A', memberships: [{ section: { gid: 's1', name: '📋 Ready to start' }, project: { gid: 'proj1' } }] }),
          ]),
      });

      // Tasks from "In Progress"
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          pagedResponse([
            asanaTask({ gid: '201', name: 'Task B' }),
          ]),
      });

      const issues = await tracker.fetchCandidateIssues();
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe('200');
      expect(issues[1].id).toBe('201');
    });

    it('returns empty array when no sections match active states', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          singleResponse([
            asanaSection('s1', '📥 Inbox'),
            asanaSection('s3', '✅ Shipped'),
          ]),
      });

      const issues = await tracker.fetchCandidateIssues();
      expect(issues).toEqual([]);
    });
  });

  // -- Pagination ----------------------------------------------------------

  describe('pagination', () => {
    it('follows next_page.offset until null', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          singleResponse([asanaSection('s2', '🚧 In Progress')]),
      });

      // Page 1 — has next_page
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          pagedResponse(
            [asanaTask({ gid: '100', name: 'Task 1' })],
            'page2offset',
          ),
      });

      // Page 2 — no next_page
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          pagedResponse([asanaTask({ gid: '101', name: 'Task 2' })]),
      });

      const issues = await tracker.fetchCandidateIssues();
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe('100');
      expect(issues[1].id).toBe('101');

      // Verify the second page request includes offset
      const secondPageCall = fetchMock.mock.calls[2];
      expect(secondPageCall[0]).toContain('offset=page2offset');
    });
  });

  // -- fetchIssuesByStates -------------------------------------------------

  describe('fetchIssuesByStates', () => {
    it('filters sections by provided states', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          singleResponse([
            asanaSection('s1', '📋 Ready to start'),
            asanaSection('s2', '🚧 In Progress'),
            asanaSection('s3', '✅ Shipped'),
          ]),
      });

      // Only "Shipped" should match
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          pagedResponse([
            asanaTask({
              gid: '300',
              name: 'Done task',
              memberships: [{ section: { gid: 's3', name: '✅ Shipped' }, project: { gid: 'proj1' } }],
            }),
          ]),
      });

      const issues = await tracker.fetchIssuesByStates(['Shipped']);
      expect(issues).toHaveLength(1);
      expect(issues[0].state).toBe('Shipped');
    });
  });

  // -- fetchIssueStatesByIds -----------------------------------------------

  describe('fetchIssueStatesByIds', () => {
    it('returns minimal issues with current state', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            gid: '500',
            memberships: [
              {
                section: { gid: 's3', name: '✅ Shipped' },
                project: { gid: 'proj1' },
              },
            ],
            completed: true,
          },
        }),
      });

      const issues = await tracker.fetchIssueStatesByIds(['500']);
      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe('500');
      expect(issues[0].state).toBe('Shipped');
      expect(issues[0].title).toBe('');
    });

    it('skips 404 tasks (returns null)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const issues = await tracker.fetchIssueStatesByIds(['999']);
      expect(issues).toHaveLength(0);
    });
  });

  // -- Normalization -------------------------------------------------------

  describe('normalization', () => {
    it('maps dependencies to blockedBy', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          singleResponse([asanaSection('s2', '🚧 In Progress')]),
      });

      const task = asanaTask({
        dependencies: [
          { gid: 'd1', name: 'Blocker task', completed: false },
          { gid: 'd2', name: 'Done blocker', completed: true },
        ],
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => pagedResponse([task]),
      });

      const issues = await tracker.fetchCandidateIssues();
      expect(issues[0].blockedBy).toEqual([
        { id: 'd1', identifier: 'd1', state: 'open' },
        { id: 'd2', identifier: 'd2', state: 'completed' },
      ]);
    });

    it('lowercases tag names as labels', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          singleResponse([asanaSection('s2', '🚧 In Progress')]),
      });

      const task = asanaTask({
        tags: [
          { gid: 't1', name: 'Frontend' },
          { gid: 't2', name: 'URGENT' },
        ],
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => pagedResponse([task]),
      });

      const issues = await tracker.fetchCandidateIssues();
      expect(issues[0].labels).toEqual(['frontend', 'urgent']);
    });

    it('resolves priority from custom field (number)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          singleResponse([asanaSection('s2', '🚧 In Progress')]),
      });

      const task = asanaTask({
        custom_fields: [
          { gid: 'cf1', name: 'Priority', display_value: '1', number_value: 1, enum_value: null },
        ],
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => pagedResponse([task]),
      });

      const issues = await tracker.fetchCandidateIssues();
      expect(issues[0].priority).toBe(1);
    });

    it('resolves priority from custom field (enum)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          singleResponse([asanaSection('s2', '🚧 In Progress')]),
      });

      const task = asanaTask({
        custom_fields: [
          { gid: 'cf1', name: 'Priority', display_value: 'High', number_value: null, enum_value: { name: 'High' } },
        ],
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => pagedResponse([task]),
      });

      const issues = await tracker.fetchCandidateIssues();
      expect(issues[0].priority).toBe(1);
    });

    it('sets description to null when notes is empty', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          singleResponse([asanaSection('s2', '🚧 In Progress')]),
      });

      const task = asanaTask({ notes: '' });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => pagedResponse([task]),
      });

      const issues = await tracker.fetchCandidateIssues();
      expect(issues[0].description).toBeNull();
    });

    it('sets state to Unknown when no project membership matches', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          singleResponse([asanaSection('s2', '🚧 In Progress')]),
      });

      const task = asanaTask({
        memberships: [
          { section: { gid: 'sx', name: 'Other' }, project: { gid: 'other-proj' } },
        ],
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => pagedResponse([task]),
      });

      const issues = await tracker.fetchCandidateIssues();
      expect(issues[0].state).toBe('Unknown');
    });
  });

  // -- Error handling ------------------------------------------------------

  describe('error handling', () => {
    it('throws on non-200 response from sections API', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      await expect(tracker.fetchCandidateIssues()).rejects.toThrow(
        'Asana API error: 401 Unauthorized',
      );
    });

    it('throws on non-200 response from tasks API', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          singleResponse([asanaSection('s2', '🚧 In Progress')]),
      });

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(tracker.fetchCandidateIssues()).rejects.toThrow(
        'Asana API error: 500 Internal Server Error',
      );
    });

    it('throws on non-200 response from fetchIssueStatesByIds', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });

      await expect(tracker.fetchIssueStatesByIds(['123'])).rejects.toThrow(
        'Asana API error: 403 Forbidden',
      );
    });
  });

  // -- Auth header ---------------------------------------------------------

  describe('authorization', () => {
    it('sends Bearer token in Authorization header', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => singleResponse([]),
      });

      await tracker.fetchCandidateIssues();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key',
          }),
        }),
      );
    });
  });
});
