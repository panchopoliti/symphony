# Symphony Node.js

Node.js/TypeScript implementation of the Symphony orchestration service. Polls Asana for candidate tasks, creates isolated workspaces, and runs a Claude coding agent via the Vercel AI SDK.

## Prerequisites

- Node.js 20+
- Environment variables:
  - `ASANA_ACCESS_TOKEN` — Asana personal access token with read/write access to your project
  - `ANTHROPIC_API_KEY` — Anthropic API key for Claude
  - `SOURCE_REPO_URL` (optional) — Git repository URL used by the `after_create` hook to clone into workspaces

## Setup

```bash
cd node
npm install
```

## Configuration

Edit `WORKFLOW.md` to configure Symphony. The file uses YAML front matter for configuration and a Markdown body as the prompt template sent to Claude.

### Key settings

| Setting | Description | Default |
|---------|-------------|---------|
| `tracker.kind` | Issue tracker type | `asana` |
| `tracker.api_key` | API key (use `$ENV_VAR` syntax) | — |
| `tracker.project_id` | Asana project GID | — |
| `tracker.active_states` | Section names that trigger agent runs | `[Ready to start, In Progress]` |
| `tracker.terminal_states` | Section names that mark work as done | `[Shipped]` |
| `polling.interval_ms` | Poll interval in milliseconds | `30000` |
| `workspace.root` | Root directory for workspaces (`~` expands to home) | — |
| `hooks.after_create` | Shell script run after workspace creation | — |
| `hooks.before_run` | Shell script run before each agent attempt | — |
| `hooks.after_run` | Shell script run after each agent attempt | — |
| `hooks.before_remove` | Shell script run before workspace removal | — |
| `agent.max_concurrent_agents` | Max parallel agent sessions | `10` |
| `agent.max_turns` | Max turns per agent attempt | `20` |
| `claude.model` | Claude model to use | `claude-sonnet-4-20250514` |
| `server.port` | HTTP dashboard port (omit to disable) | — |

### Prompt template variables

The Markdown body of `WORKFLOW.md` is a [Liquid](https://liquidjs.com/) template with these variables:

- `issue.identifier` — Task ID
- `issue.title` — Task name
- `issue.description` — Task notes
- `issue.state` — Current section name
- `issue.url` — Asana permalink
- `issue.labels` — Tag names (array)
- `issue.blocked_by` — Blocking dependencies (array)
- `attempt` — Retry attempt number (`null` on first run)

## Running

```bash
# Using npm start (default: reads ./WORKFLOW.md)
npm start

# With explicit workflow file and port
npx tsx bin/symphony.ts WORKFLOW.md --port 4000

# With log file output
npx tsx bin/symphony.ts --port 4000 --logs-root ./logs
```

When `--port` is specified, a dashboard is available at `http://localhost:<port>/` showing running sessions, retry queue, and token usage.

### API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | HTML dashboard (auto-refreshes every 5s) |
| `GET` | `/api/v1/state` | Runtime snapshot as JSON |
| `GET` | `/api/v1/:identifier` | Details for a specific issue |
| `POST` | `/api/v1/refresh` | Trigger an immediate poll cycle |

## Architecture

```
bin/symphony.ts          CLI entry point
src/index.ts             Bootstrap / startSymphony()
src/orchestrator.ts      Core state machine (poll, dispatch, reconcile, retry)
src/agent-runner.ts      Per-issue worker (workspace + prompt + turn loop)
src/agent/claude.ts      Claude agent via Vercel AI SDK
src/tracker/asana.ts     Asana REST API adapter
src/workspace.ts         Workspace lifecycle and hooks
src/workflow.ts          WORKFLOW.md parser (YAML front matter + Liquid body)
src/config.ts            Config parsing, defaults, validation
src/prompt-builder.ts    Liquid template rendering
src/logger.ts            Structured logging (pino)
src/server/              HTTP server and dashboard
src/types.ts             Shared domain types
```

## Development

```bash
# Type-check
npx tsc --noEmit

# Run tests
npx vitest run

# Run tests in watch mode
npx vitest
```
