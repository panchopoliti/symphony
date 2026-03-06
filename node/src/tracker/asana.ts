// Symphony Node.js — Asana Tracker Adapter
// Implements TrackerAdapter for Asana's REST API.

import type { Issue, BlockerRef, TrackerAdapter } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip leading emoji + optional space from a section name.
 * e.g. "🚧 In Progress" → "In Progress", "📥 Inbox" → "Inbox"
 */
export function stripEmoji(name: string): string {
  // Remove leading characters that are NOT basic ASCII letters/digits/space/punctuation,
  // then trim leading whitespace.
  return name.replace(/^[^\x20-\x7E]+/u, '').trimStart();
}

/**
 * Compare a section name (possibly emoji-prefixed) to a configured state name,
 * case-insensitive, after stripping emoji and trimming.
 */
export function matchesState(sectionName: string, configuredState: string): boolean {
  return stripEmoji(sectionName).toLowerCase() === configuredState.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Asana API types (partial, just what we need)
// ---------------------------------------------------------------------------

interface AsanaSection {
  gid: string;
  name: string;
}

interface AsanaTag {
  gid: string;
  name: string;
}

interface AsanaDependency {
  gid: string;
  name: string;
  completed: boolean;
}

interface AsanaMembership {
  section?: {
    gid: string;
    name: string;
  };
  project?: {
    gid: string;
  };
}

interface AsanaCustomField {
  gid: string;
  name: string;
  display_value: string | null;
  number_value: number | null;
  enum_value: { name: string } | null;
}

interface AsanaTask {
  gid: string;
  name: string;
  notes: string;
  completed: boolean;
  assignee: { name: string } | null;
  tags: AsanaTag[];
  dependencies: AsanaDependency[];
  memberships: AsanaMembership[];
  permalink_url: string;
  custom_fields: AsanaCustomField[];
  created_at: string;
  modified_at: string;
}

interface AsanaPagedResponse<T> {
  data: T[];
  next_page: { offset: string; uri: string } | null;
}

// ---------------------------------------------------------------------------
// AsanaTracker
// ---------------------------------------------------------------------------

export interface AsanaTrackerConfig {
  endpoint: string;
  apiKey: string;
  projectId: string;
  activeStates: string[];
  terminalStates: string[];
}

export class AsanaTracker implements TrackerAdapter {
  private endpoint: string;
  private apiKey: string;
  private projectId: string;
  private activeStates: string[];
  private terminalStates: string[];

  constructor(config: AsanaTrackerConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.projectId = config.projectId;
    this.activeStates = config.activeStates;
    this.terminalStates = config.terminalStates;
  }

  // -------------------------------------------------------------------------
  // TrackerAdapter interface
  // -------------------------------------------------------------------------

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchIssuesByStates(this.activeStates);
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const sections = await this.fetchSections();
    const matchingSections = sections.filter((s) =>
      states.some((state) => matchesState(s.name, state)),
    );

    const allTasks: AsanaTask[] = [];
    for (const section of matchingSections) {
      const tasks = await this.fetchTasksForSection(section.gid);
      allTasks.push(...tasks);
    }

    return allTasks.map((task) => this.normalizeTask(task));
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    const issues: Issue[] = [];
    for (const id of ids) {
      const task = await this.fetchTaskById(id);
      if (task) {
        issues.push(this.normalizeMinimalTask(task));
      }
    }
    return issues;
  }

  // -------------------------------------------------------------------------
  // Asana API calls
  // -------------------------------------------------------------------------

  private async fetchSections(): Promise<AsanaSection[]> {
    const url = `${this.endpoint}/projects/${this.projectId}/sections`;
    const data = await this.get<AsanaSection[]>(url);
    return data;
  }

  private async fetchTasksForSection(sectionGid: string): Promise<AsanaTask[]> {
    const optFields = [
      'name',
      'notes',
      'completed',
      'assignee.name',
      'tags.name',
      'dependencies.name',
      'dependencies.completed',
      'memberships.section.name',
      'memberships.project.gid',
      'permalink_url',
      'custom_fields',
      'created_at',
      'modified_at',
    ].join(',');

    const allTasks: AsanaTask[] = [];
    let offset: string | null = null;

    do {
      const params = new URLSearchParams({
        opt_fields: optFields,
        limit: '100',
      });
      if (offset) {
        params.set('offset', offset);
      }

      const url = `${this.endpoint}/sections/${sectionGid}/tasks?${params.toString()}`;
      const response = await this.getPaged<AsanaTask>(url);
      allTasks.push(...response.data);
      offset = response.next_page?.offset ?? null;
    } while (offset);

    return allTasks;
  }

  private async fetchTaskById(
    gid: string,
  ): Promise<{ gid: string; memberships: AsanaMembership[]; completed: boolean } | null> {
    const optFields = 'memberships.section.name,memberships.project.gid,completed';
    const url = `${this.endpoint}/tasks/${gid}?opt_fields=${optFields}`;
    try {
      const response = await this.request(url);
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Asana API error: ${response.status} ${response.statusText}`);
      }
      const json = (await response.json()) as { data: { gid: string; memberships: AsanaMembership[]; completed: boolean } };
      return json.data;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) return null;
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------

  private async request(url: string): Promise<Response> {
    return fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
      },
    });
  }

  private async get<T>(url: string): Promise<T> {
    const response = await this.request(url);
    if (!response.ok) {
      throw new Error(`Asana API error: ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as { data: T };
    return json.data;
  }

  private async getPaged<T>(url: string): Promise<AsanaPagedResponse<T>> {
    const response = await this.request(url);
    if (!response.ok) {
      throw new Error(`Asana API error: ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as AsanaPagedResponse<T>;
    return json;
  }

  // -------------------------------------------------------------------------
  // Normalization
  // -------------------------------------------------------------------------

  private normalizeTask(task: AsanaTask): Issue {
    const state = this.resolveState(task.memberships);
    const priority = this.resolvePriority(task.custom_fields ?? []);

    const blockedBy: BlockerRef[] = (task.dependencies ?? []).map((dep) => ({
      id: dep.gid,
      identifier: dep.gid,
      state: dep.completed ? 'completed' : 'open',
    }));

    return {
      id: task.gid,
      identifier: task.gid,
      title: task.name,
      description: task.notes || null,
      priority,
      state,
      branchName: null,
      url: task.permalink_url || null,
      labels: (task.tags ?? []).map((t) => t.name.toLowerCase()),
      blockedBy,
      createdAt: task.created_at ? new Date(task.created_at) : null,
      updatedAt: task.modified_at ? new Date(task.modified_at) : null,
    };
  }

  private normalizeMinimalTask(task: {
    gid: string;
    memberships: AsanaMembership[];
    completed: boolean;
  }): Issue {
    const state = this.resolveState(task.memberships);
    return {
      id: task.gid,
      identifier: task.gid,
      title: '',
      description: null,
      priority: null,
      state,
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    };
  }

  private resolveState(memberships: AsanaMembership[]): string {
    // Find the membership for our project and get the section name
    const membership = memberships.find(
      (m) => m.section && (!m.project || m.project.gid === this.projectId),
    );
    if (!membership?.section) return 'Unknown';
    return stripEmoji(membership.section.name);
  }

  private resolvePriority(customFields: AsanaCustomField[]): number | null {
    const priorityField = customFields.find(
      (f) => f.name.toLowerCase() === 'priority',
    );
    if (!priorityField) return null;
    if (priorityField.number_value !== null) return priorityField.number_value;
    if (priorityField.enum_value?.name) {
      // Map common priority names to numbers
      const mapping: Record<string, number> = {
        urgent: 0,
        high: 1,
        medium: 2,
        low: 3,
        none: 4,
      };
      return mapping[priorityField.enum_value.name.toLowerCase()] ?? null;
    }
    return null;
  }
}
