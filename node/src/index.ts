// Symphony Node.js — Bootstrap
// Reusable entry point that wires up all components and starts the orchestrator.

import { resolve } from 'node:path';
import { loadWorkflow, watchWorkflow } from './workflow.js';
import { parseConfig, validateConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { AsanaTracker } from './tracker/asana.js';
import { ClaudeAgent } from './agent/claude.js';
import { ClaudeCodeCliAgent } from './agent/claude-cli.js';
import { ActivityLogStore } from './activity-log.js';
import { Orchestrator } from './orchestrator.js';
import { startServer } from './server/index.js';

export interface StartOptions {
  workflowPath: string;
  port?: number;
  logsRoot?: string;
}

export interface SymphonyInstance {
  orchestrator: Orchestrator;
  logger: Logger;
  shutdown: () => Promise<void>;
}

export async function startSymphony(opts: StartOptions): Promise<SymphonyInstance> {
  const workflowPath = resolve(opts.workflowPath);

  // 1. Load and parse workflow
  const workflow = loadWorkflow(workflowPath);
  const config = parseConfig(workflow.config);

  // Override port if specified via CLI
  if (opts.port !== undefined) {
    (config as { server: { port: number | null } }).server.port = opts.port;
  }

  // 2. Validate config
  const validation = validateConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid config:\n  ${validation.errors.join('\n  ')}`);
  }

  // 3. Create logger
  const logger = createLogger(opts.logsRoot ? { logsRoot: opts.logsRoot } : undefined);

  logger.info({ workflowPath }, 'Loaded workflow');
  logger.info(
    {
      tracker: config.tracker.kind,
      projectId: config.tracker.projectId,
      activeStates: config.tracker.activeStates,
      pollIntervalMs: config.polling.intervalMs,
      maxConcurrentAgents: config.agent.maxConcurrentAgents,
      model: config.claude.model,
      provider: config.claude.provider,
    },
    'Config summary',
  );

  // 4. Create tracker
  const tracker = new AsanaTracker({
    endpoint: config.tracker.endpoint,
    apiKey: config.tracker.apiKey,
    projectId: config.tracker.projectId,
    activeStates: config.tracker.activeStates,
    terminalStates: config.tracker.terminalStates,
  });

  // 5. Create agent
  const activityLog = new ActivityLogStore();
  const agent = config.claude.provider === 'api'
    ? new ClaudeAgent({ model: config.claude.model, activityLog })
    : new ClaudeCodeCliAgent({ model: config.claude.model, activityLog });

  // 6. Create orchestrator
  const orchestrator = new Orchestrator({
    config,
    tracker,
    agent,
    promptTemplate: workflow.promptTemplate,
    logger,
  });

  // 7. Watch workflow for hot reload
  watchWorkflow(workflowPath, (wf) => {
    logger.info('Workflow file changed, reloading config');
    try {
      const newConfig = parseConfig(wf.config);
      const newValidation = validateConfig(newConfig);
      if (!newValidation.valid) {
        logger.warn({ errors: newValidation.errors }, 'Updated workflow has invalid config, ignoring');
        return;
      }
      // Preserve CLI overrides
      if (opts.port !== undefined) {
        (newConfig as { server: { port: number | null } }).server.port = opts.port;
      }
      orchestrator.updateConfig(newConfig, wf.promptTemplate);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ error: msg }, 'Failed to reload workflow, keeping current config');
    }
  });

  // 8. Start orchestrator
  await orchestrator.start();

  // 9. Start HTTP server if port configured
  let httpServer: import('node:http').Server | null = null;
  const effectivePort = config.server.port;
  if (effectivePort !== null) {
    httpServer = await startServer(effectivePort, orchestrator, activityLog);
    logger.info({ port: effectivePort }, 'HTTP server listening on 127.0.0.1');
  }

  // 10. Return instance with shutdown handle
  const shutdown = async () => {
    logger.info('Shutting down Symphony');
    if (httpServer) {
      await new Promise<void>((res, rej) => httpServer!.close((err) => (err ? rej(err) : res())));
    }
    await orchestrator.shutdown();
  };

  return { orchestrator, logger, shutdown };
}
