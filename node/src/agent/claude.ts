// Symphony Node.js — Claude Agent via Vercel AI SDK
// Implements AgentAdapter using generateText with tools for agentic coding loops.

import { generateText, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentAdapter, AgentEvent, ServiceConfig, TurnResult } from '../types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Path validation — tool paths must stay inside workspacePath
// ---------------------------------------------------------------------------

export function validateToolPath(workspacePath: string, toolPath: string): string {
  const absWorkspace = resolve(workspacePath);
  const absTarget = resolve(workspacePath, toolPath);
  if (!absTarget.startsWith(absWorkspace + '/') && absTarget !== absWorkspace) {
    throw new Error(
      `Path "${toolPath}" resolves to "${absTarget}" which is outside workspace "${absWorkspace}"`,
    );
  }
  return absTarget;
}

// ---------------------------------------------------------------------------
// System prompt for the coding agent
// ---------------------------------------------------------------------------

function buildSystemPrompt(workspacePath: string): string {
  return [
    'You are a coding assistant working in the following directory:',
    workspacePath,
    '',
    'You have tools available to run bash commands, read files, write files, and list files.',
    'All file paths are relative to the workspace directory above.',
    'Complete the task described in the user prompt. Be thorough and precise.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function createTools(workspacePath: string) {
  return {
    bash: tool({
      description: 'Execute a bash command in the workspace directory. Returns stdout and stderr.',
      parameters: z.object({
        command: z.string().describe('The bash command to execute'),
        description: z.string().optional().describe('Brief description of what this command does'),
      }),
      execute: async ({ command }) => {
        try {
          const { stdout, stderr } = await execFileAsync('bash', ['-lc', command], {
            cwd: workspacePath,
            timeout: 120_000, // 2 minute timeout per command
            maxBuffer: 10 * 1024 * 1024, // 10MB
          });
          return { stdout, stderr, exitCode: 0 };
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; code?: number | string };
          return {
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? (err instanceof Error ? err.message : String(err)),
            exitCode: typeof e.code === 'number' ? e.code : 1,
          };
        }
      },
    }),

    readFile: tool({
      description: 'Read the contents of a file relative to the workspace directory.',
      parameters: z.object({
        path: z.string().describe('File path relative to the workspace'),
      }),
      execute: async ({ path }) => {
        const absPath = validateToolPath(workspacePath, path);
        const content = await readFile(absPath, 'utf-8');
        return { content };
      },
    }),

    writeFile: tool({
      description: 'Write content to a file relative to the workspace directory. Creates parent directories if needed.',
      parameters: z.object({
        path: z.string().describe('File path relative to the workspace'),
        content: z.string().describe('Content to write to the file'),
      }),
      execute: async ({ path, content }) => {
        const absPath = validateToolPath(workspacePath, path);
        // Ensure parent directory exists
        const { mkdir } = await import('node:fs/promises');
        const { dirname } = await import('node:path');
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, content, 'utf-8');
        return { written: true, path };
      },
    }),

    listFiles: tool({
      description: 'List files and directories in a directory relative to the workspace.',
      parameters: z.object({
        directory: z.string().optional().describe('Directory path relative to workspace (defaults to workspace root)'),
      }),
      execute: async ({ directory }) => {
        const dir = directory ?? '.';
        const absDir = validateToolPath(workspacePath, dir);
        const entries = await readdir(absDir, { withFileTypes: true });
        const files = entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' as const : 'file' as const,
        }));
        return { files };
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// ClaudeAgent — AgentAdapter implementation
// ---------------------------------------------------------------------------

export class ClaudeAgent implements AgentAdapter {
  private model: string;

  constructor(opts?: { model?: string }) {
    this.model = opts?.model ?? 'claude-sonnet-4-20250514';
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

    // Emit session_started
    onMessage({
      event: 'session_started',
      timestamp: new Date(),
      sessionId,
      usage: null,
      payload: { model: this.model, workspacePath },
    });

    try {
      const tools = createTools(workspacePath);
      const systemPrompt = buildSystemPrompt(workspacePath);

      const result = await generateText({
        model: anthropic(this.model),
        system: systemPrompt,
        prompt,
        tools,
        maxSteps: 50,
        abortSignal: signal,
      });

      const usage = {
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
        totalTokens: result.usage.promptTokens + result.usage.completionTokens,
      };

      // Emit turn_completed
      onMessage({
        event: 'turn_completed',
        timestamp: new Date(),
        sessionId,
        usage,
        payload: {
          finishReason: result.finishReason,
          stepCount: result.steps.length,
          text: result.text,
        },
      });

      return {
        status: 'completed',
        usage,
        stepCount: result.steps.length,
      };
    } catch (err: unknown) {
      // Check if it was an abort/cancellation
      if (signal.aborted) {
        onMessage({
          event: 'turn_cancelled',
          timestamp: new Date(),
          sessionId,
          usage: null,
          payload: { reason: 'aborted' },
        });
        return {
          status: 'cancelled',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          stepCount: 0,
        };
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[ClaudeAgent] Turn failed for workspace ${workspacePath}:`, errorMessage);

      onMessage({
        event: 'turn_failed',
        timestamp: new Date(),
        sessionId,
        usage: null,
        payload: { error: errorMessage },
      });

      return {
        status: 'failed',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        stepCount: 0,
        error: errorMessage,
      };
    }
  }
}
