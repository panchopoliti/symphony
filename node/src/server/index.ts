// Symphony Node.js — HTTP Server
// Optional HTTP server for observability, started only when --port is specified.
// Based on SPEC.md Section 13.7.

import http from 'node:http';
import express from 'express';
import type { Orchestrator } from '../orchestrator.js';
import type { ActivityLogStore } from '../activity-log.js';
import { createRoutes } from './routes.js';

export async function startServer(
  port: number,
  orchestrator: Orchestrator,
  activityLog?: ActivityLogStore,
): Promise<http.Server> {
  const app = express();

  // Parse JSON bodies for POST routes
  app.use(express.json());

  // Mount routes
  app.use(createRoutes(orchestrator, activityLog));

  // 405 for unsupported methods on known paths
  app.all('/api/v1/state', (_req, res) => {
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'Use GET for this endpoint' } });
  });
  app.all('/api/v1/refresh', (_req, res) => {
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'Use POST for this endpoint' } });
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
    server.on('error', reject);
  });
}
