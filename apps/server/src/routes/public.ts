import { Router } from 'express';
import { lookup } from 'node:dns/promises';
import { z } from 'zod';
import { ah, HttpError, isPrivateHost, notFound, parse } from '../util.js';
import { requireSiteAccess, siteUrl } from '../site/routes.js';
import { searchSpace } from '../search/search.js';
import { track } from '../analytics.js';
import { aiEnabled, chatStream, type ChatMessage } from '../ai/provider.js';
import { buildAnswerMessages, extractiveAnswer } from '../ai/features.js';
import { json, one, query } from '../db.js';
import { rateLimit } from '../auth/session.js';
import { emit } from '../events.js';
import { config } from '../config.js';
import type { SpaceSettings } from '../permissions.js';
import { deref, listOperations } from '../content/openapi.js';

export const publicRouter = Router();

publicRouter.get(
  '/sites/:spaceId/search',
  rateLimit('search', 120, 60),
  ah(async (req, res) => {
    const space = await requireSiteAccess(req, res, req.params.spaceId);
    if (!space) throw notFound('Site');
    const q = String(req.query.q || '').slice(0, 300);
    const results = await searchSpace(space, q, 10);
    if (q.length >= 2) track(req, { spaceId: space.id, type: 'search', query: q, resultsCount: results.length });
    res.json({ results: results.map(({ text: _t, ...r }) => r) });
  }),
);

const askSchema = z.object({
  question: z.string().min(1).max(1000),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) })).max(12).optional(),
});

publicRouter.post(
  '/sites/:spaceId/ask',
  rateLimit('ask', 20, 60),
  ah(async (req, res) => {
    const space = await requireSiteAccess(req, res, req.params.spaceId);
    if (!space) throw notFound('Site');
    if (json<SpaceSettings>(space.settings, {}).aiEnabled === false) throw new HttpError(403, 'AI assistant is disabled for this site');
    const body = parse(askSchema, req.body);
    const history = (body.history || []) as ChatMessage[];
    // Use the previous question as extra retrieval context for follow-ups.
    const lastUser = [...history].reverse().find((m) => m.role === 'user');
    const hits = await searchSpace(space, lastUser ? `${body.question} ${lastUser.content}` : body.question, 6);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ type: 'sources', sources: hits.map((h) => ({ title: h.title, heading: h.heading, path: h.path, anchor: h.anchor })) });
    let answer = '';
    if (aiEnabled()) {
      try {
        for await (const chunk of chatStream(buildAnswerMessages(body.question, hits, history, space.name), { temperature: 0.2 })) {
          answer += chunk;
          send({ type: 'delta', text: chunk });
        }
      } catch (err) {
        answer = extractiveAnswer(body.question, hits);
        send({ type: 'delta', text: answer });
        send({ type: 'error', message: '_(AI model unavailable — showing matching passages instead.)_' });
        void err;
      }
    } else {
      answer = extractiveAnswer(body.question, hits);
      send({ type: 'delta', text: answer });
    }
    const unanswered = !hits.length || /could not find|couldn't find|not in the (provided )?documentation/i.test(answer);
    track(req, {
      spaceId: space.id,
      type: 'ai_question',
      query: body.question,
      resultsCount: hits.length,
      meta: { unanswered, topScore: hits[0]?.score ?? 0 },
    });
    send({ type: 'done' });
    res.end();
  }),
);

const feedbackSchema = z.object({
  pageId: z.string().max(36).nullable().optional(),
  rating: z.number().int().min(-1).max(1),
  comment: z.string().max(2000).optional(),
});

publicRouter.post(
  '/sites/:spaceId/feedback',
  rateLimit('feedback', 30, 60),
  ah(async (req, res) => {
    const space = await requireSiteAccess(req, res, req.params.spaceId);
    if (!space) throw notFound('Site');
    const body = parse(feedbackSchema, req.body);
    track(req, { spaceId: space.id, type: 'feedback', pageStableId: body.pageId ?? null, rating: body.rating, comment: body.comment ?? null });
    if (body.comment) void emit('feedback.received', { orgId: space.org_id, spaceId: space.id }, { pageId: body.pageId, rating: body.rating, comment: body.comment });
    res.json({ ok: true });
  }),
);

publicRouter.post(
  '/sites/:spaceId/events',
  rateLimit('events', 60, 60),
  ah(async (req, res) => {
    const space = await requireSiteAccess(req, res, req.params.spaceId);
    if (!space) throw notFound('Site');
    if (req.body?.type === 'api_call') {
      track(req, { spaceId: space.id, type: 'api_call', pageStableId: req.body.pageId ?? null, meta: req.body.meta ?? null });
    }
    res.json({ ok: true });
  }),
);

const proxySchema = z.object({
  url: z.string().url().max(4000),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  headers: z.record(z.string().max(4000)).optional(),
  body: z.string().max(1_000_000).nullable().optional(),
});

/**
 * Server-side relay for the API playground (avoids browser CORS limits). Only forwards to hosts
 * declared as servers in this space's OpenAPI specs, and blocks private networks unless allowed.
 */
publicRouter.post(
  '/sites/:spaceId/playground',
  rateLimit('playground', 30, 60),
  ah(async (req, res) => {
    const space = await requireSiteAccess(req, res, req.params.spaceId);
    if (!space) throw notFound('Site');
    const body = parse(proxySchema, req.body);
    const target = new URL(body.url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new HttpError(400, 'Only http(s) URLs are allowed');
    const specs = await query('SELECT spec FROM openapi_specs WHERE space_id=?', [space.id]);
    const allowedHosts = new Set<string>();
    for (const s of specs) {
      const spec = json<any>(s.spec, {});
      for (const srv of spec.servers || []) {
        try {
          allowedHosts.add(new URL(srv.url).host);
        } catch {
          /* relative server urls */
        }
      }
    }
    if (!allowedHosts.has(target.host)) throw new HttpError(403, `Host ${target.host} is not a server declared in this site's API specs`);
    if (!config.playgroundProxyAllowPrivate) {
      const addr = await lookup(target.hostname).catch(() => null);
      if (isPrivateHost(target.hostname) || (addr && isPrivateHost(addr.address))) throw new HttpError(403, 'Private network targets are blocked (set PLAYGROUND_PROXY_ALLOW_PRIVATE=true to allow)');
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.headers || {})) if (!/^(host|cookie|content-length|connection)$/i.test(k)) headers[k] = v;
    try {
      const upstream = await fetch(target, {
        method: body.method,
        headers,
        body: body.method === 'GET' || body.method === 'HEAD' ? undefined : body.body ?? undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
      const text = await upstream.text();
      res.json({ status: upstream.status, statusText: upstream.statusText, headers: Object.fromEntries(upstream.headers), body: text.slice(0, 2_000_000) });
    } catch (err) {
      res.json({ status: 0, statusText: 'Network error', error: (err as Error).message });
    }
  }),
);

/** Public operation index for a site (used by AI agents / tooling). */
publicRouter.get(
  '/sites/:spaceId/openapi',
  ah(async (req, res) => {
    const space = await requireSiteAccess(req, res, req.params.spaceId);
    if (!space) throw notFound('Site');
    const specs = await query('SELECT id, name, spec FROM openapi_specs WHERE space_id=?', [space.id]);
    res.json({
      specs: specs.map((s) => {
        const spec = deref(json(s.spec, {}));
        return { id: s.id, name: s.name, operations: listOperations(spec).map((o) => ({ method: o.method, path: o.path, summary: o.summary })) };
      }),
    });
  }),
);

publicRouter.get(
  '/sites/:spaceId/info',
  ah(async (req, res) => {
    const space = await requireSiteAccess(req, res, req.params.spaceId);
    if (!space) throw notFound('Site');
    const org = await one('SELECT slug FROM organizations WHERE id=?', [space.org_id]);
    res.json({ id: space.id, name: space.name, url: siteUrl(space, org?.slug ?? '') });
  }),
);
