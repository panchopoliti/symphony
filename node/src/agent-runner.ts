// Symphony Node.js — Agent Runner
// Per-issue worker: workspace creation → prompt rendering → agent turn loop.
// Based on SPEC.md Section 16.5 (Worker Attempt algorithm)

import { createForIssue, runHook, workspacePath } from './workspace.js';
import { renderPrompt } from './prompt-builder.js';
import type {
  AgentAdapter,
  AgentEvent,
  Issue,
  ServiceConfig,
  TrackerAdapter,
  TurnResult,
} from './types.js';
import type { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// AgentRunnerResult — returned from runAgentAttempt
// ---------------------------------------------------------------------------

export interface AgentRunnerResult {
  turnCount: number;
  totalTokens: { inputTokens: number; outputTokens: number; totalTokens: number };
  status: 'completed' | 'failed' | 'cancelled' | 'max_turns_reached';
  error?: string;
}

// ---------------------------------------------------------------------------
// Continuation prompt for turn N > 1
// ---------------------------------------------------------------------------

function buildContinuationPrompt(turnNumber: number, maxTurns: number): string {
  return [
    'Continuation guidance:',
    `- The previous turn completed normally, but the issue is still in an active state.`,
    `- This is continuation turn #${turnNumber} of #${maxTurns} for the current agent run.`,
    '- Resume from the current workspace state instead of restarting from scratch.',
    '- The original task instructions and prior turn context are already present in this thread.',
    '- Focus on remaining work and do not end the turn while the issue stays active unless blocked.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// runAgentAttempt — the main worker entry point
// ---------------------------------------------------------------------------

export async function runAgentAttempt(opts: {
  issue: Issue;
  attempt: number | null;
  config: ServiceConfig;
  promptTemplate: string;
  tracker: TrackerAdapter;
  agent: AgentAdapter;
  logger: Logger;
  onUpdate: (event: AgentEvent) => void;
  signal: AbortSignal;
}): Promise<AgentRunnerResult> {
  const { issue, attempt, config, promptTemplate, tracker, agent, logger, onUpdate, signal } = opts;

  const totalTokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let turnCount = 0;

  // 1. Create/reuse workspace
  logger.info({ issueId: issue.id, identifier: issue.identifier }, 'Creating workspace');
  const { path: wsPath, createdNow } = await createForIssue(
    config.workspace.root,
    issue.identifier,
    config.hooks,
  );
  logger.info({ issueId: issue.id, wsPath, createdNow }, 'Workspace ready');

  // 2. Run beforeRun hook (failure is fatal — aborts the attempt)
  if (config.hooks.beforeRun) {
    logger.info({ issueId: issue.id }, 'Running beforeRun hook');
    await runHook(config.hooks.beforeRun, wsPath, config.hooks.timeoutMs);
  }

  try {
    // 3. Turn loop
    while (turnCount < config.agent.maxTurns) {
      // Check for abort before starting turn
      if (signal.aborted) {
        return { turnCount, totalTokens, status: 'cancelled' };
      }

      // Build prompt: first turn uses rendered template, continuation uses guidance
      const prompt =
        turnCount === 0
          ? renderPrompt(promptTemplate, issue, attempt)
          : buildContinuationPrompt(turnCount + 1, config.agent.maxTurns);

      logger.info(
        { issueId: issue.id, turn: turnCount + 1, maxTurns: config.agent.maxTurns },
        'Starting agent turn',
      );

      // Run the agent turn
      const turnResult: TurnResult = await agent.runTurn({
        prompt,
        workspacePath: wsPath,
        config,
        onMessage: (event) => onUpdate(event),
        signal,
      });

      turnCount++;

      // Accumulate token usage
      totalTokens.inputTokens += turnResult.usage.inputTokens;
      totalTokens.outputTokens += turnResult.usage.outputTokens;
      totalTokens.totalTokens += turnResult.usage.totalTokens;

      // If turn failed or was cancelled, stop
      if (turnResult.status === 'failed') {
        logger.error({ issueId: issue.id, turn: turnCount, error: turnResult.error }, 'Agent turn failed');
        return { turnCount, totalTokens, status: 'failed', error: turnResult.error };
      }

      if (turnResult.status === 'cancelled') {
        logger.info({ issueId: issue.id, turn: turnCount }, 'Agent turn cancelled');
        return { turnCount, totalTokens, status: 'cancelled' };
      }

      // Re-fetch issue state to check if still active
      logger.debug({ issueId: issue.id }, 'Re-fetching issue state');
      const refreshed = await tracker.fetchIssueStatesByIds([issue.id]);
      const currentIssue = refreshed.find((i) => i.id === issue.id);

      if (currentIssue) {
        const isActive = config.tracker.activeStates.some(
          (s) => s.toLowerCase() === currentIssue.state.toLowerCase(),
        );
        if (!isActive) {
          logger.info(
            { issueId: issue.id, state: currentIssue.state },
            'Issue no longer in active state, stopping',
          );
          break;
        }
      } else {
        // Issue not found — stop
        logger.warn({ issueId: issue.id }, 'Issue not found after state refresh, stopping');
        break;
      }
    }

    const status = turnCount >= config.agent.maxTurns ? 'max_turns_reached' : 'completed';
    if (status === 'max_turns_reached') {
      logger.warn({ issueId: issue.id, turnCount }, 'Max turns reached');
    }

    return { turnCount, totalTokens, status };
  } finally {
    // 4. Run afterRun hook (best-effort — log errors and ignore)
    if (config.hooks.afterRun) {
      try {
        logger.info({ issueId: issue.id }, 'Running afterRun hook');
        await runHook(config.hooks.afterRun, wsPath, config.hooks.timeoutMs);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ issueId: issue.id, error: message }, 'afterRun hook failed (ignored)');
      }
    }
  }
}
