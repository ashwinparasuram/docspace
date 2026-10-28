import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { authenticate, csrfGuard } from './auth/session.js';
import { HttpError } from './util.js';
import { authRouter } from './routes/auth.js';
import { orgsRouter } from './routes/orgs.js';
import { spacesRouter, filesRouter } from './routes/spaces.js';
import { pagesRouter } from './routes/pages.js';
import { crRouter } from './routes/changeRequests.js';
import { commentsRouter } from './routes/comments.js';
import { insightsRouter } from './routes/insights.js';
import { adminRouter } from './routes/admin.js';
import { publicRouter } from './routes/public.js';
import { siteAssets, siteRouter, customDomainHandler } from './site/routes.js';
import { one, pingDb } from './db.js';
import { cache } from './redis.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);

  app.use(
    helmet({
      // The editor and published sites need inline styles; scripts are restricted to this origin.
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'script-src': ["'self'", "'unsafe-inline'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
          'media-src': ["'self'", 'blob:', 'https:', 'http:'],
          'connect-src': ["'self'", 'ws:', 'wss:', 'https:', 'http:'],
          'frame-src': ["'self'", 'https:'],
          'font-src': ["'self'", 'data:'],
          'upgrade-insecure-requests': config.appUrl.startsWith('https://') ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '12mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.get('/healthz', async (_req, res) => {
    const db = await pingDb();
    const redis = await cache.ping();
    res.status(db ? 200 : 503).json({ ok: db, db, cache: { kind: cache.kind, ok: redis } });
  });

  // Caddy "on_demand_tls ask" hook: only issue certificates for verified custom domains.
  app.get('/internal/tls-check', async (req, res) => {
    const domain = String(req.query.domain || '').toLowerCase();
    const ok = domain === config.appHost.split(':')[0] || !!(await one('SELECT id FROM spaces WHERE custom_domain=? AND domain_verified=1', [domain]));
    res.status(ok ? 200 : 404).end();
  });

  // Published sites on custom domains take precedence over everything else.
  app.use(siteAssets);
  app.use(customDomainHandler);

  app.use('/files', filesRouter);
  app.use('/api/public', publicRouter);

  const api = express.Router();
  api.use(authenticate);
  api.use(csrfGuard);
  api.use('/auth', authRouter);
  api.use('/orgs', orgsRouter);
  api.use('/spaces', spacesRouter);
  api.use('/admin', adminRouter);
  api.use(pagesRouter);
  api.use(crRouter);
  api.use(commentsRouter);
  api.use(insightsRouter);
  api.use((_req, _res, next) => next(new HttpError(404, 'API route not found')));
  app.use('/api', api);

  app.use(siteRouter);

  // Single-page app (editor/dashboard). Built assets are served by Node in production.
  if (existsSync(join(config.webDist, 'index.html'))) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h', setHeaders: (res, path) => /\/assets\//.test(path.replace(/\\/g, '/')) && res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') }));
    app.get('*', (_req, res) => res.sendFile(join(config.webDist, 'index.html')));
  } else {
    app.get('/', (_req, res) => {
      res.type('html').send('<p>DocSpace API is running. Start the web app with <code>npm run dev</code> (http://localhost:5173) or build it with <code>npm run build</code>.</p>');
    });
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    const e = err as Error & { type?: string; code?: string; status?: number };
    if (e.type === 'entity.too.large' || e.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'Upload too large' });
      return;
    }
    if (e.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    logger.error('Unhandled error', { path: req.path, error: e.message, stack: config.isProd ? undefined : e.stack });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
