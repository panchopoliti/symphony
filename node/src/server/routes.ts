// Symphony Node.js — HTTP Server Routes
// REST API and HTML dashboard for observability.
// Based on SPEC.md Section 13.7.

import { Router, type Request, type Response } from 'express';
import type { Orchestrator } from '../orchestrator.js';
import type { ActivityLogStore } from '../activity-log.js';

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
          <td><a href="/log/${esc(r.identifier)}">View Log</a></td>
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
    <thead><tr><th>Identifier</th><th>Title</th><th>State</th><th>Turns</th><th>Tokens</th><th>Last Event</th><th>Started</th><th>Log</th></tr></thead>
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
// Log Viewer HTML — Conversation-style UI (Claude Desktop / Conductor inspired)
// ---------------------------------------------------------------------------

function renderLogViewer(identifier: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Log - ${esc(identifier)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      margin: 0; padding: 0;
      background: #1a1a1a;
      color: #e8e8e8;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* ── Header ─────────────────────────────────────────────── */
    .header {
      padding: 12px 20px;
      background: #242424;
      border-bottom: 1px solid #333;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    .header .back {
      color: #888;
      text-decoration: none;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: color 0.15s;
    }
    .header .back:hover { color: #ccc; }
    .header .back svg { width: 16px; height: 16px; }
    .header .title {
      font-size: 14px;
      font-weight: 600;
      color: #e0e0e0;
    }
    .header .status {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #888;
    }
    .header .status-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: #4caf50;
      animation: pulse 2s infinite;
    }
    .header .status-dot.disconnected { background: #666; animation: none; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* ── Conversation area ──────────────────────────────────── */
    #log {
      flex: 1;
      overflow-y: auto;
      padding: 20px 0;
      scroll-behavior: smooth;
    }
    #log::-webkit-scrollbar { width: 6px; }
    #log::-webkit-scrollbar-track { background: transparent; }
    #log::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
    #log::-webkit-scrollbar-thumb:hover { background: #555; }

    .conversation {
      max-width: 760px;
      margin: 0 auto;
      padding: 0 20px;
    }

    .empty-state {
      text-align: center;
      color: #555;
      padding: 60px 20px;
      font-size: 14px;
    }
    .empty-state .spinner {
      width: 24px; height: 24px;
      border: 2px solid #333;
      border-top-color: #888;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 12px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Agent message ──────────────────────────────────────── */
    .msg {
      margin-bottom: 2px;
      animation: fadeIn 0.2s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .msg-text {
      padding: 10px 0;
      font-size: 14px;
      line-height: 1.6;
      color: #e0e0e0;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg-text code {
      background: #2a2a2a;
      padding: 1px 5px;
      border-radius: 3px;
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      font-size: 12.5px;
      color: #c9d1d9;
    }

    /* ── Thinking/Reasoning block ───────────────────────────── */
    .thinking {
      margin: 8px 0;
    }
    .thinking-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 0;
      cursor: pointer;
      user-select: none;
      color: #888;
      font-size: 12px;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
    }
    .thinking-toggle:hover { color: #aaa; }
    .thinking-toggle svg {
      width: 12px; height: 12px;
      transition: transform 0.15s;
      flex-shrink: 0;
    }
    .thinking.open .thinking-toggle svg { transform: rotate(90deg); }
    .thinking-content {
      display: none;
      padding: 8px 12px;
      margin: 2px 0 8px;
      background: #222;
      border-radius: 6px;
      border-left: 2px solid #444;
      font-size: 13px;
      line-height: 1.5;
      color: #999;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 300px;
      overflow-y: auto;
    }
    .thinking.open .thinking-content { display: block; }

    /* ── Tool call group ────────────────────────────────────── */
    .tool-group {
      margin: 6px 0;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      overflow: hidden;
      background: #1e1e1e;
    }
    .tool-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      color: #e0e0e0;
      transition: background 0.1s;
    }
    .tool-header:hover { background: #252525; }
    .tool-header svg {
      width: 14px; height: 14px;
      transition: transform 0.15s;
      flex-shrink: 0;
      color: #888;
    }
    .tool-group.open .tool-header svg { transform: rotate(90deg); }
    .tool-icon {
      width: 22px; height: 22px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      flex-shrink: 0;
      font-weight: 700;
      color: #fff;
    }
    .tool-icon.bash { background: #3b82f6; }
    .tool-icon.read, .tool-icon.glob, .tool-icon.grep { background: #8b5cf6; }
    .tool-icon.write, .tool-icon.edit { background: #f59e0b; }
    .tool-icon.default { background: #6b7280; }
    .tool-name {
      font-size: 13px;
      font-weight: 500;
      color: #ccc;
    }
    .tool-summary {
      font-size: 12px;
      color: #666;
      margin-left: auto;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 300px;
    }
    .tool-body {
      display: none;
      border-top: 1px solid #2a2a2a;
    }
    .tool-group.open .tool-body { display: block; }
    .tool-section {
      padding: 10px 12px;
      font-size: 12px;
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.5;
      color: #b0b0b0;
      max-height: 400px;
      overflow-y: auto;
    }
    .tool-section::-webkit-scrollbar { width: 4px; }
    .tool-section::-webkit-scrollbar-thumb { background: #444; border-radius: 2px; }
    .tool-section-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #555;
      padding: 6px 12px 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .tool-section.result {
      background: #1a1f1a;
      border-top: 1px solid #2a2a2a;
    }

    /* ── Error block ────────────────────────────────────────── */
    .msg-error {
      margin: 8px 0;
      padding: 10px 12px;
      background: #2a1a1a;
      border: 1px solid #5c2020;
      border-radius: 8px;
      font-size: 13px;
      color: #f87171;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      line-height: 1.5;
    }
    .msg-error::before {
      content: '';
      display: inline-block;
      width: 14px; height: 14px;
      margin-right: 6px;
      vertical-align: -2px;
      background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%23f87171'%3E%3Cpath d='M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 4a.75.75 0 011.5 0v3a.75.75 0 01-1.5 0V5zm.75 6.25a.75.75 0 100-1.5.75.75 0 000 1.5z'/%3E%3C/svg%3E") no-repeat center/contain;
    }

    /* ── Scroll-to-bottom button ────────────────────────────── */
    .scroll-btn {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #333;
      border: 1px solid #444;
      color: #ccc;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      cursor: pointer;
      display: none;
      align-items: center;
      gap: 4px;
      transition: background 0.15s;
      z-index: 10;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    .scroll-btn:hover { background: #444; }
    .scroll-btn svg { width: 12px; height: 12px; }
    .scroll-btn.visible { display: flex; }

    /* ── Timestamp separator ────────────────────────────────── */
    .ts-sep {
      text-align: center;
      margin: 16px 0;
      font-size: 11px;
      color: #555;
    }
  </style>
</head>
<body>
  <div class="header">
    <a class="back" href="/">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M7.78 12.53a.75.75 0 01-1.06 0L2.47 8.28a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 1.06L4.81 7h7.44a.75.75 0 010 1.5H4.81l2.97 2.97a.75.75 0 010 1.06z"/></svg>
      Dashboard
    </a>
    <div class="title">${esc(identifier)}</div>
    <div class="status">
      <span class="status-dot" id="statusDot"></span>
      <span id="statusText">Connected</span>
    </div>
  </div>

  <div id="log">
    <div class="conversation" id="conv">
      <div class="empty-state"><div class="spinner"></div>Waiting for activity...</div>
    </div>
  </div>

  <button class="scroll-btn" id="scrollBtn" onclick="scrollToBottom()">
    <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 11.5a.75.75 0 01-.53-.22l-3.25-3.25a.75.75 0 111.06-1.06L8 9.69l2.72-2.72a.75.75 0 111.06 1.06l-3.25 3.25a.75.75 0 01-.53.22z"/></svg>
    New activity
  </button>

  <script>
    const CHEVRON = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6.22 4.22a.75.75 0 011.06 0l3.25 3.25a.75.75 0 010 1.06l-3.25 3.25a.75.75 0 01-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 010-1.06z"/></svg>';
    const IDENTIFIER = '${esc(identifier)}';
    let prevCount = 0;
    let userScrolled = false;

    // Scroll tracking
    const logEl = document.getElementById('log');
    const scrollBtn = document.getElementById('scrollBtn');

    logEl.addEventListener('scroll', () => {
      const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
      userScrolled = !atBottom;
      scrollBtn.classList.toggle('visible', userScrolled);
    });

    function scrollToBottom() {
      logEl.scrollTop = logEl.scrollHeight;
      userScrolled = false;
      scrollBtn.classList.remove('visible');
    }

    function escHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function relTime(ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    // Parse tool name from "toolName: {json}" format
    function parseToolCall(content) {
      const colonIdx = content.indexOf(':');
      if (colonIdx === -1) return { name: content.trim(), args: '' };
      return {
        name: content.substring(0, colonIdx).trim(),
        args: content.substring(colonIdx + 1).trim(),
      };
    }

    // Get a one-line summary for the tool
    function toolSummary(name, args) {
      try {
        const parsed = JSON.parse(args);
        if (name === 'Bash' || name === 'bash') return parsed.command ? truncate(parsed.command, 50) : '';
        if (name === 'Read' || name === 'read') return parsed.file_path ? truncate(parsed.file_path, 50) : '';
        if (name === 'Write' || name === 'write') return parsed.file_path ? truncate(parsed.file_path, 50) : '';
        if (name === 'Edit' || name === 'edit') return parsed.file_path ? truncate(parsed.file_path, 50) : '';
        if (name === 'Glob' || name === 'glob') return parsed.pattern ? truncate(parsed.pattern, 50) : '';
        if (name === 'Grep' || name === 'grep') return parsed.pattern ? truncate(parsed.pattern, 50) : '';
        return '';
      } catch { return ''; }
    }

    function truncate(s, n) {
      return s.length > n ? s.substring(0, n) + '...' : s;
    }

    function toolIconClass(name) {
      const n = name.toLowerCase();
      if (n === 'bash') return 'bash';
      if (n === 'read' || n === 'glob' || n === 'grep') return 'read';
      if (n === 'write' || n === 'edit') return 'write';
      return 'default';
    }

    function toolIconLetter(name) {
      const n = name.toLowerCase();
      if (n === 'bash') return '>';
      if (n === 'read') return 'R';
      if (n === 'glob') return 'G';
      if (n === 'grep') return 'S';
      if (n === 'write') return 'W';
      if (n === 'edit') return 'E';
      return name.charAt(0).toUpperCase();
    }

    // Group entries into renderable blocks
    function groupEntries(entries) {
      const groups = [];
      let i = 0;
      while (i < entries.length) {
        const e = entries[i];
        if (e.type === 'tool_call') {
          // Look ahead for a matching tool_result
          const group = { type: 'tool', call: e, result: null };
          if (i + 1 < entries.length && entries[i + 1].type === 'tool_result') {
            group.result = entries[i + 1];
            i += 2;
          } else {
            i++;
          }
          groups.push(group);
        } else {
          groups.push({ type: e.type, entry: e });
          i++;
        }
      }
      return groups;
    }

    function renderGroups(groups) {
      let html = '';
      for (const g of groups) {
        if (g.type === 'text') {
          html += '<div class="msg"><div class="msg-text">' + formatText(escHtml(g.entry.content)) + '</div></div>';
        } else if (g.type === 'reasoning') {
          html += renderThinking(g.entry);
        } else if (g.type === 'tool') {
          html += renderToolGroup(g);
        } else if (g.type === 'error') {
          html += '<div class="msg"><div class="msg-error">' + escHtml(g.entry.content) + '</div></div>';
        }
      }
      return html;
    }

    function formatText(escaped) {
      // Basic inline code formatting
      return escaped.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    }

    function renderThinking(entry) {
      const preview = truncate(entry.content, 60);
      return '<div class="thinking">' +
        '<button class="thinking-toggle" onclick="this.parentElement.classList.toggle(\\\'open\\\')">' +
          CHEVRON +
          '<span>Thinking...</span>' +
        '</button>' +
        '<div class="thinking-content">' + escHtml(entry.content) + '</div>' +
      '</div>';
    }

    function renderToolGroup(g) {
      const tc = parseToolCall(g.call.content);
      const summary = toolSummary(tc.name, tc.args);
      const iconCls = toolIconClass(tc.name);
      const iconLetter = toolIconLetter(tc.name);

      let bodyHtml = '<div class="tool-section-label">Input</div>' +
        '<div class="tool-section">' + escHtml(tc.args) + '</div>';

      if (g.result) {
        bodyHtml += '<div class="tool-section-label">Output</div>' +
          '<div class="tool-section result">' + escHtml(truncateResult(g.result.content)) + '</div>';
      }

      return '<div class="tool-group">' +
        '<button class="tool-header" onclick="this.parentElement.classList.toggle(\\\'open\\\')">' +
          CHEVRON +
          '<div class="tool-icon ' + iconCls + '">' + iconLetter + '</div>' +
          '<span class="tool-name">' + escHtml(tc.name) + '</span>' +
          (summary ? '<span class="tool-summary">' + escHtml(summary) + '</span>' : '') +
        '</button>' +
        '<div class="tool-body">' + bodyHtml + '</div>' +
      '</div>';
    }

    function truncateResult(content) {
      const maxLen = 5000;
      if (content.length <= maxLen) return content;
      return content.substring(0, maxLen) + '\\n\\n... (' + (content.length - maxLen).toLocaleString() + ' characters truncated)';
    }

    async function refresh() {
      try {
        const res = await fetch('/api/v1/' + IDENTIFIER + '/log');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const entries = await res.json();

        document.getElementById('statusDot').classList.remove('disconnected');
        document.getElementById('statusText').textContent = entries.length + ' entries';

        const conv = document.getElementById('conv');

        if (entries.length === 0) {
          conv.innerHTML = '<div class="empty-state"><div class="spinner"></div>Waiting for activity...</div>';
          prevCount = 0;
          return;
        }

        // Only re-render if new entries arrived
        if (entries.length !== prevCount) {
          const groups = groupEntries(entries);
          conv.innerHTML = renderGroups(groups);
          prevCount = entries.length;

          if (!userScrolled) {
            requestAnimationFrame(() => { logEl.scrollTop = logEl.scrollHeight; });
          }
        }
      } catch (err) {
        console.error('Log refresh failed:', err);
        document.getElementById('statusDot').classList.add('disconnected');
        document.getElementById('statusText').textContent = 'Disconnected';
      }
    }

    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createRoutes(orchestrator: Orchestrator, activityLog?: ActivityLogStore): Router {
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

  // GET /log/:identifier — HTML log viewer
  router.get('/log/:identifier', (req: Request, res: Response) => {
    const identifier = req.params.identifier as string;
    res.type('html').send(renderLogViewer(identifier));
  });

  // GET /api/v1/:identifier/log — activity log JSON
  router.get('/api/v1/:identifier/log', (req: Request, res: Response) => {
    const identifier = req.params.identifier as string;
    if (!activityLog) {
      res.json([]);
      return;
    }
    const entries = activityLog.getLog(identifier).map((e) => ({
      timestamp: e.timestamp.toISOString(),
      type: e.type,
      content: e.content,
    }));
    res.json(entries);
  });

  // GET /api/v1/:identifier — issue-specific details
  const reservedPaths = new Set(['state', 'refresh']);
  router.get('/api/v1/:identifier', (req: Request, res: Response) => {
    const identifier = req.params.identifier as string;

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
