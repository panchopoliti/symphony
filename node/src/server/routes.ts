// Symphony Node.js — HTTP Server Routes
// REST API and HTML dashboard for observability.
// Based on SPEC.md Section 13.7.

import { Router, type Request, type Response } from 'express';
import type { Orchestrator } from '../orchestrator.js';

// ---------------------------------------------------------------------------
// JSON serializer — handles Date → ISO string, strips non-serializable fields
// ---------------------------------------------------------------------------

function serializeSnapshot(snapshot: ReturnType<Orchestrator['getSnapshot']>): unknown {
  return {
    running: snapshot.running.map((r) => ({
      issueId: r.issueId,
      identifier: r.identifier,
      sessionId: r.sessionId,
      turnCount: r.turnCount,
      startedAt: r.startedAt.toISOString(),
      lastEvent: r.lastEvent,
      lastEventAt: r.lastEventAt?.toISOString() ?? null,
      lastMessage: r.lastMessage,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      totalTokens: r.totalTokens,
      retryAttempt: r.retryAttempt,
      issue: {
        id: r.issue.id,
        identifier: r.issue.identifier,
        title: r.issue.title,
        state: r.issue.state,
        priority: r.issue.priority,
        url: r.issue.url,
      },
    })),
    retrying: snapshot.retrying.map((r) => ({
      issueId: r.issueId,
      identifier: r.identifier,
      attempt: r.attempt,
      dueAtMs: r.dueAtMs,
      error: r.error,
    })),
    codexTotals: snapshot.codexTotals,
    rateLimits: snapshot.rateLimits,
    generatedAt: snapshot.generatedAt.toISOString(),
    counts: snapshot.counts,
  };
}

// ---------------------------------------------------------------------------
// HTML Dashboard
// ---------------------------------------------------------------------------

function renderDashboard(snapshot: ReturnType<Orchestrator['getSnapshot']>): string {
  const runningRows = snapshot.running
    .map(
      (r) =>
        `<tr>
          <td>${esc(r.identifier)}</td>
          <td>${esc(r.issue.title)}</td>
          <td>${esc(r.issue.state)}</td>
          <td>${r.turnCount}</td>
          <td>${r.totalTokens.toLocaleString()}</td>
          <td>${r.lastEvent ?? '-'}</td>
          <td>${r.startedAt.toISOString()}</td>
        </tr>`,
    )
    .join('\n');

  const retryRows = snapshot.retrying
    .map(
      (r) =>
        `<tr>
          <td>${esc(r.identifier)}</td>
          <td>${r.attempt}</td>
          <td>${new Date(r.dueAtMs).toISOString()}</td>
          <td>${esc(r.error ?? '-')}</td>
        </tr>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="5">
  <title>Symphony Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 2rem; background: #f5f5f5; color: #333; }
    h1 { margin-bottom: 0.25rem; }
    .subtitle { color: #666; margin-bottom: 1.5rem; }
    .stats { display: flex; gap: 1.5rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
    .stat { background: #fff; padding: 1rem 1.5rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .stat-value { font-size: 1.5rem; font-weight: 700; }
    .stat-label { color: #666; font-size: 0.85rem; }
    table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 1.5rem; }
    th, td { padding: 0.6rem 1rem; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #fafafa; font-weight: 600; font-size: 0.85rem; text-transform: uppercase; color: #666; }
    td { font-size: 0.9rem; }
    .empty { color: #999; font-style: italic; padding: 1rem; }
    h2 { margin-top: 1.5rem; margin-bottom: 0.5rem; }
  </style>
</head>
<body>
  <h1>Symphony Dashboard</h1>
  <p class="subtitle">Generated at ${snapshot.generatedAt.toISOString()}</p>

  <div class="stats">
    <div class="stat"><div class="stat-value">${snapshot.counts.running}</div><div class="stat-label">Running</div></div>
    <div class="stat"><div class="stat-value">${snapshot.counts.retrying}</div><div class="stat-label">Retrying</div></div>
    <div class="stat"><div class="stat-value">${snapshot.counts.claimed}</div><div class="stat-label">Claimed</div></div>
    <div class="stat"><div class="stat-value">${snapshot.counts.completed}</div><div class="stat-label">Completed</div></div>
    <div class="stat"><div class="stat-value">${snapshot.codexTotals.totalTokens.toLocaleString()}</div><div class="stat-label">Total Tokens</div></div>
    <div class="stat"><div class="stat-value">${Math.round(snapshot.codexTotals.secondsRunning)}s</div><div class="stat-label">Total Runtime</div></div>
  </div>

  <h2>Running Sessions</h2>
  ${
    snapshot.running.length === 0
      ? '<p class="empty">No running sessions</p>'
      : `<table>
    <thead><tr><th>Identifier</th><th>Title</th><th>State</th><th>Turns</th><th>Tokens</th><th>Last Event</th><th>Started</th></tr></thead>
    <tbody>${runningRows}</tbody>
  </table>`
  }

  <h2>Retry Queue</h2>
  ${
    snapshot.retrying.length === 0
      ? '<p class="empty">No retries pending</p>'
      : `<table>
    <thead><tr><th>Identifier</th><th>Attempt</th><th>Due At</th><th>Error</th></tr></thead>
    <tbody>${retryRows}</tbody>
  </table>`
  }
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createRoutes(orchestrator: Orchestrator): Router {
  const router = Router();

  // GET / — HTML dashboard
  router.get('/', (_req: Request, res: Response) => {
    const snapshot = orchestrator.getSnapshot();
    res.type('html').send(renderDashboard(snapshot));
  });

  // GET /api/v1/state — runtime snapshot JSON
  router.get('/api/v1/state', (_req: Request, res: Response) => {
    const snapshot = orchestrator.getSnapshot();
    res.json(serializeSnapshot(snapshot));
  });

  // POST /api/v1/refresh — trigger immediate poll
  router.post('/api/v1/refresh', (_req: Request, res: Response) => {
    orchestrator.triggerRefresh();
    res.status(202).json({ queued: true });
  });

  // GET /api/v1/:identifier — issue-specific details
  const reservedPaths = new Set(['state', 'refresh']);
  router.get('/api/v1/:identifier', (req: Request, res: Response) => {
    const { identifier } = req.params;

    if (reservedPaths.has(identifier)) {
      res.status(405).json({ error: { code: 'method_not_allowed', message: `Use ${identifier === 'state' ? 'GET' : 'POST'} for /api/v1/${identifier}` } });
      return;
    }

    const snapshot = orchestrator.getSnapshot();

    // Search in running sessions
    const running = snapshot.running.find((r) => r.identifier === identifier);
    if (running) {
      res.json({
        status: 'running',
        issueId: running.issueId,
        identifier: running.identifier,
        sessionId: running.sessionId,
        turnCount: running.turnCount,
        startedAt: running.startedAt.toISOString(),
        lastEvent: running.lastEvent,
        lastEventAt: running.lastEventAt?.toISOString() ?? null,
        lastMessage: running.lastMessage,
        inputTokens: running.inputTokens,
        outputTokens: running.outputTokens,
        totalTokens: running.totalTokens,
        retryAttempt: running.retryAttempt,
        issue: {
          id: running.issue.id,
          identifier: running.issue.identifier,
          title: running.issue.title,
          state: running.issue.state,
          priority: running.issue.priority,
          url: running.issue.url,
        },
      });
      return;
    }

    // Search in retry queue
    const retrying = snapshot.retrying.find((r) => r.identifier === identifier);
    if (retrying) {
      res.json({
        status: 'retrying',
        issueId: retrying.issueId,
        identifier: retrying.identifier,
        attempt: retrying.attempt,
        dueAtMs: retrying.dueAtMs,
        error: retrying.error,
      });
      return;
    }

    // Not found
    res.status(404).json({ error: { code: 'not_found', message: `Issue "${identifier}" not found in running or retry state` } });
  });

  return router;
}
