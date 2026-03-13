import { describe, it, expect } from 'vitest';
import { ActivityLogStore } from '../src/activity-log.js';

describe('ActivityLogStore', () => {
  it('returns empty array for unknown identifier', () => {
    const store = new ActivityLogStore();
    expect(store.getLog('nonexistent')).toEqual([]);
  });

  it('appends and retrieves log entries', () => {
    const store = new ActivityLogStore();
    const entry = { timestamp: new Date(), type: 'text' as const, content: 'hello' };
    store.append('task-1', entry);

    const log = store.getLog('task-1');
    expect(log).toHaveLength(1);
    expect(log[0].content).toBe('hello');
    expect(log[0].type).toBe('text');
  });

  it('keeps entries separate per identifier', () => {
    const store = new ActivityLogStore();
    store.append('task-1', { timestamp: new Date(), type: 'text', content: 'a' });
    store.append('task-2', { timestamp: new Date(), type: 'error', content: 'b' });

    expect(store.getLog('task-1')).toHaveLength(1);
    expect(store.getLog('task-2')).toHaveLength(1);
    expect(store.getLog('task-1')[0].content).toBe('a');
    expect(store.getLog('task-2')[0].content).toBe('b');
  });

  it('caps entries at 1000 per identifier', () => {
    const store = new ActivityLogStore();
    for (let i = 0; i < 1050; i++) {
      store.append('task-1', { timestamp: new Date(), type: 'text', content: `entry-${i}` });
    }

    const log = store.getLog('task-1');
    expect(log).toHaveLength(1000);
    // Oldest entries should have been dropped
    expect(log[0].content).toBe('entry-50');
    expect(log[999].content).toBe('entry-1049');
  });

  it('clears entries for an identifier', () => {
    const store = new ActivityLogStore();
    store.append('task-1', { timestamp: new Date(), type: 'text', content: 'a' });
    store.append('task-1', { timestamp: new Date(), type: 'text', content: 'b' });

    store.clear('task-1');
    expect(store.getLog('task-1')).toEqual([]);
  });

  it('clear does not affect other identifiers', () => {
    const store = new ActivityLogStore();
    store.append('task-1', { timestamp: new Date(), type: 'text', content: 'a' });
    store.append('task-2', { timestamp: new Date(), type: 'text', content: 'b' });

    store.clear('task-1');
    expect(store.getLog('task-1')).toEqual([]);
    expect(store.getLog('task-2')).toHaveLength(1);
  });

  it('supports all log entry types', () => {
    const store = new ActivityLogStore();
    const types = ['reasoning', 'tool_call', 'tool_result', 'text', 'error'] as const;
    for (const type of types) {
      store.append('task-1', { timestamp: new Date(), type, content: `${type} content` });
    }

    const log = store.getLog('task-1');
    expect(log).toHaveLength(5);
    expect(log.map((e) => e.type)).toEqual([...types]);
  });
});
