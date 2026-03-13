// Symphony Node.js — Structured Logger
// Based on SPEC.md Section 13 (Logging, Status, Observability)

import pino from 'pino';
import path from 'node:path';
import fs from 'node:fs';

export type Logger = pino.Logger;

/**
 * Create a pino logger instance.
 * Logs to stdout by default; if logsRoot is provided, also writes to a file.
 */
export function createLogger(opts?: { logsRoot?: string }): Logger {
  const targets: pino.TransportTargetOptions[] = [
    { target: 'pino-pretty', options: { destination: 1, colorize: true }, level: 'info' },
  ];

  if (opts?.logsRoot) {
    fs.mkdirSync(opts.logsRoot, { recursive: true });
    const logFile = path.join(opts.logsRoot, 'symphony.log');
    targets.push({
      target: 'pino/file',
      options: { destination: logFile },
      level: 'debug',
    });
  }

  return pino({
    level: 'debug',
    transport: { targets },
  });
}

/**
 * Create a child logger with issue context fields.
 * Per SPEC.md 13.1: issue_id and issue_identifier are required context.
 */
export function issueLogger(
  parent: Logger,
  issueId: string,
  issueIdentifier: string,
): Logger {
  return parent.child({ issueId, issueIdentifier });
}

/**
 * Create a child logger with session context.
 * Per SPEC.md 13.1: session_id is required context for session lifecycle logs.
 */
export function sessionLogger(parent: Logger, sessionId: string): Logger {
  return parent.child({ sessionId });
}

/** Default singleton logger (stdout only). */
const defaultLogger = createLogger();
export default defaultLogger;
