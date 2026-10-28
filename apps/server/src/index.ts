import http from 'node:http';
import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './migrate.js';
import { createApp } from './app.js';
import { createCollabServer, flushCollab } from './collab.js';
import { startWebhookWorker } from './events.js';
import { startAnalyticsFlusher, flushAnalytics } from './analytics.js';
import { reconcileIndexes } from './search/indexer.js';
import { cache } from './redis.js';
import { storage } from './storage.js';
import { aiInfo } from './ai/provider.js';
import { pool } from './db.js';

async function main() {
  if (config.isProd && config.secret === 'dev-insecure-secret-change-me') {
    logger.error('APP_SECRET must be set in production. Run `npm run setup` to generate a .env file.');
    process.exit(1);
  }
  await runMigrations();
  await storage.ping();
  const app = createApp();
  const server = http.createServer(app);
  const collab = createCollabServer();
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/collab/')) collab.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  server.keepAliveTimeout = 65_000;

  if (process.env.DISABLE_WORKERS !== 'true') {
    startWebhookWorker();
    void reconcileIndexes().catch((err) => logger.warn('index reconcile failed', { error: (err as Error).message }));
  }
  startAnalyticsFlusher();

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${config.port} is already in use — another DocSpace (or other app) is running. Stop it, or set PORT in .env to a free port.`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(config.port, config.host || undefined, () => {
    logger.info(`DocSpace listening on ${config.appUrl} (port ${config.port})`, {
      cache: cache.kind,
      storage: storage.kind,
      ai: aiInfo().provider,
    });
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    server.close();
    await flushCollab().catch(() => {});
    await flushAnalytics().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: (err as Error).message });
  if ((err as any).code === 'ECONNREFUSED' || (err as any).code === 'ER_ACCESS_DENIED_ERROR') {
    logger.error(`Cannot connect to MySQL at ${config.db.host}:${config.db.port} as "${config.db.user}". Check DB_* settings in .env.`);
  }
  process.exit(1);
});
