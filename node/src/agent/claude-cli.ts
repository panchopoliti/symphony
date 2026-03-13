// Symphony Node.js — Claude Code CLI Agent
// Implements AgentAdapter by spawning the `claude` CLI process.
// Uses the user's Pro/Max subscription — no separate API key needed.

import { spawn, type ChildProcess } from 'node:child_process';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentAdapter, AgentEvent, ServiceConfig, TurnResult } from '../types.js';
import type { ActivityLogStore } from '../activity-log.js';

// ---------------------------------------------------------------------------
// ClaudeCodeCliAgent — AgentAdapter implementation via CLI
// ---------------------------------------------------------------------------

export class ClaudeCodeCliAgent implements AgentAdapter {
  private model: string;
  private activityLog: ActivityLogStore | null;

  constructor(opts?: { model?: string; activityLog?: ActivityLogStore }) {
    this.model = opts?.model ?? 'claude-sonnet-4-20250514';
    this.activityLog = opts?.activityLog ?? null;
  }

  async runTurn(opts: {
    prompt: string;
    workspacePath: string;
    config: ServiceConfig;
    onMessage: (event: AgentEvent) => void;
    signal: AbortSignal;
  }): Promise<TurnResult> {
    const { prompt, workspacePath, onMessage, signal } = opts;
    const sessionId = crypto.randomUUID();
    const identifier = basename(workspacePath);

    // Emit session_started
    onMessage({
      event: 'session_started',
      timestamp: new Date(),
      sessionId,
      usage: null,
      payload: { model: this.model, workspacePath, provider: 'cli' },
    });

    return new Promise<TurnResult>((resolve) => {
      const args = [
        '--print',
        '--verbose',
        '--output-format', 'stream-json',
        '--model', this.model,
        '--max-turns', '50',
        prompt,
      ];

      let child: ChildProcess;
      try {
        child = spawn('claude', args, {
          cwd: workspacePath,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logActivity(identifier, 'error', `Failed to spawn claude CLI: ${errorMessage}`);
        onMessage({
          event: 'turn_failed',
          timestamp: new Date(),
          sessionId,
          usage: null,
          payload: { error: errorMessage },
        });
        resolve({
          status: 'failed',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          stepCount: 0,
          error: errorMessage,
        });
        return;
      }

      let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let stepCount = 0;
      let lastResultText = '';
      let settled = false;

      const finish = (result: TurnResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      // Handle abort signal
      const onAbort = () => {
        child.kill('SIGTERM');
        this.logActivity(identifier, 'error', 'Agent turn aborted');
        onMessage({
          event: 'turn_cancelled',
          timestamp: new Date(),
          sessionId,
          usage: null,
          payload: { reason: 'aborted' },
        });
        finish({
          status: 'cancelled',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          stepCount: 0,
        });
      };

      if (signal.aborted) {
        child.kill('SIGTERM');
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });

      // Parse stdout line by line (stream-json format)
      if (child.stdout) {
        const rl = createInterface({ input: child.stdout });
        rl.on('line', (line) => {
          if (settled) return;
          try {
            const event = JSON.parse(line);
            this.processStreamEvent(event, identifier, sessionId, onMessage);

            // Track usage from result message
            if (event.type === 'result') {
              if (event.subtype === 'success') {
                // Extract usage if available
                if (event.usage) {
                  usage = {
                    inputTokens: event.usage.input_tokens ?? 0,
                    outputTokens: event.usage.output_tokens ?? 0,
                    totalTokens: (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0),
                  };
                }
                if (event.result !== undefined) {
                  lastResultText = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
                }
              }
            }

            // Count tool uses as steps
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'tool_use') {
                  stepCount++;
                }
              }
            }
          } catch {
            // Non-JSON line, ignore
          }
        });
      }

      // Capture stderr
      let stderrOutput = '';
      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => {
          stderrOutput += chunk.toString();
        });
      }

      // Handle process exit
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);

        if (settled) return;

        if (code !== 0 && code !== null) {
          const errorMessage = stderrOutput.trim() || `claude CLI exited with code ${code}`;
          this.logActivity(identifier, 'error', errorMessage);
          console.error(`[ClaudeCodeCliAgent] Turn failed for workspace ${workspacePath}:`, errorMessage);
          onMessage({
            event: 'turn_failed',
            timestamp: new Date(),
            sessionId,
            usage,
            payload: { error: errorMessage, exitCode: code },
          });
          finish({
            status: 'failed',
            usage,
            stepCount,
            error: errorMessage,
          });
          return;
        }

        // Success
        onMessage({
          event: 'turn_completed',
          timestamp: new Date(),
          sessionId,
          usage,
          payload: {
            finishReason: 'end_turn',
            stepCount,
            text: lastResultText,
          },
        });
        finish({
          status: 'completed',
          usage,
          stepCount,
        });
      });

      child.on('error', (err) => {
        signal.removeEventListener('abort', onAbort);
        const errorMessage = err.message;
        this.logActivity(identifier, 'error', `Process error: ${errorMessage}`);
        console.error(`[ClaudeCodeCliAgent] Turn failed for workspace ${workspacePath}:`, errorMessage);
        onMessage({
          event: 'turn_failed',
          timestamp: new Date(),
          sessionId,
          usage: null,
          payload: { error: errorMessage },
        });
        finish({
          status: 'failed',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          stepCount: 0,
          error: errorMessage,
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Stream event processing — parse claude CLI stream-json events
  // ---------------------------------------------------------------------------

  private processStreamEvent(
    event: Record<string, unknown>,
    identifier: string,
    _sessionId: string,
    _onMessage: (event: AgentEvent) => void,
  ): void {
    if (event.type === 'assistant' && event.message) {
      const message = event.message as { content?: Array<Record<string, unknown>> };
      if (message.content) {
        for (const block of message.content) {
          if (block.type === 'text') {
            this.logActivity(identifier, 'text', block.text as string);
          } else if (block.type === 'tool_use') {
            const toolName = block.name as string;
            const input = JSON.stringify(block.input, null, 2);
            this.logActivity(identifier, 'tool_call', `${toolName}: ${input}`);
          }
        }
      }
    } else if (event.type === 'tool_result' || event.type === 'user') {
      // Tool results come as user messages in the stream
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      if (message?.content) {
        for (const block of message.content) {
          if (block.type === 'tool_result') {
            const content = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            this.logActivity(identifier, 'tool_result', content);
          }
        }
      }
    } else if (event.type === 'result') {
      const subtype = event.subtype as string;
      if (subtype === 'error') {
        this.logActivity(identifier, 'error', `CLI result error: ${JSON.stringify(event.error)}`);
      }
    }
  }

  private logActivity(identifier: string, type: string, content: string): void {
    if (!this.activityLog) return;
    this.activityLog.append(identifier, {
      timestamp: new Date(),
      type: type as 'reasoning' | 'tool_call' | 'tool_result' | 'text' | 'error',
      content,
    });
  }
}
