// Symphony Node.js — Activity Log Store
// In-memory per-identifier log of agent activity (reasoning, tool calls, results).

export type LogEntryType = 'reasoning' | 'tool_call' | 'tool_result' | 'text' | 'error';

export interface LogEntry {
  timestamp: Date;
  type: LogEntryType;
  content: string;
}

const MAX_ENTRIES_PER_IDENTIFIER = 1000;

export class ActivityLogStore {
  private logs: Map<string, LogEntry[]> = new Map();

  append(identifier: string, entry: LogEntry): void {
    let entries = this.logs.get(identifier);
    if (!entries) {
      entries = [];
      this.logs.set(identifier, entries);
    }
    entries.push(entry);
    if (entries.length > MAX_ENTRIES_PER_IDENTIFIER) {
      entries.splice(0, entries.length - MAX_ENTRIES_PER_IDENTIFIER);
    }
  }

  getLog(identifier: string): LogEntry[] {
    return this.logs.get(identifier) ?? [];
  }

  clear(identifier: string): void {
    this.logs.delete(identifier);
  }
}
