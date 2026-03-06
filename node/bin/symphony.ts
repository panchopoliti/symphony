#!/usr/bin/env tsx
// Symphony Node.js — CLI Entry Point
// Parses arguments and bootstraps the orchestrator.

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startSymphony } from '../src/index.js';

// ---------------------------------------------------------------------------
// Argument parsing (no library needed)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { workflowPath: string; port?: number; logsRoot?: string } {
  const args = argv.slice(2); // strip node + script path
  let workflowPath = './WORKFLOW.md';
  let port: number | undefined;
  let logsRoot: string | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--port') {
      i++;
      const val = args[i];
      if (!val || isNaN(parseInt(val, 10))) {
        console.error('Error: --port requires a numeric value');
        process.exit(1);
      }
      port = parseInt(val, 10);
    } else if (arg === '--logs-root') {
      i++;
      const val = args[i];
      if (!val) {
        console.error('Error: --logs-root requires a path value');
        process.exit(1);
      }
      logsRoot = val;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith('-')) {
      console.error(`Error: Unknown flag "${arg}"`);
      printUsage();
      process.exit(1);
    } else {
      // Positional: workflow file path
      workflowPath = arg;
    }
    i++;
  }

  return { workflowPath, port, logsRoot };
}

function printUsage(): void {
  console.log(`
Usage: symphony [options] [workflow-file]

Arguments:
  workflow-file        Path to WORKFLOW.md (default: ./WORKFLOW.md)

Options:
  --port <number>      Enable HTTP server on this port
  --logs-root <path>   Directory for log files
  -h, --help           Show this help message
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { workflowPath, port, logsRoot } = parseArgs(process.argv);
  const resolvedPath = resolve(workflowPath);

  // Validate workflow file exists
  if (!existsSync(resolvedPath)) {
    console.error(`Error: Workflow file not found: ${resolvedPath}`);
    process.exit(1);
  }

  let instance: Awaited<ReturnType<typeof startSymphony>>;
  try {
    instance = await startSymphony({ workflowPath: resolvedPath, port, logsRoot });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to start Symphony: ${msg}`);
    process.exit(1);
  }

  // Graceful shutdown on SIGINT/SIGTERM
  const onSignal = (signal: string) => {
    instance.logger.info({ signal }, 'Received signal, shutting down');
    instance.shutdown().then(
      () => process.exit(0),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error during shutdown: ${msg}`);
        process.exit(1);
      },
    );
  };

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error: ${msg}`);
  process.exit(1);
});
