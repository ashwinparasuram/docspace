import { Router } from 'express';
import { z } from 'zod';
import { json, query } from '../db.js';
import { requireAuth } from '../auth/session.js';
import { requireSpace } from '../permissions.js';
import { ah, badRequest, parse } from '../util.js';
import { getSiteData } from '../site/data.js';
import { checkQuality } from '../ai/quality.js';
import { type PMNode, emptyDoc, markdownToJson, toMarkdown } from '../content/prosemirror.js';
import { aiEnabled, aiInfo, chat, tokenize } from '../ai/provider.js';
import { WRITE_ACTIONS, writeAssistFallback, writeAssistStream, translateDoc } from '../ai/features.js';
import { createPage, getMainBranch } from '../content/pages.js';
import { canEditBranch } from '../permissions.js';
import { one } from '../db.js';
import { HttpError } from '../util.js';

export const insightsRouter = Router();
insightsRouter.use(requireAuth);

function rangeDays(q: unknown) {
  const n = Number(q);
  return [7, 30, 90, 365].includes(n) ? n : 30;
}

insightsRouter.get(
  '/spaces/:spaceId/analytics',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId);
    const days = rangeDays(req.query.days);
    const since = new Date(Date.now() - days * 86400_000);
    const site = await getSiteData(space);
    const p = [space.id, since];
    const [totals] = await query(
      `SELECT
        SUM(type='pageview' AND client_class='human') AS pageviews,
        COUNT(DISTINCT CASE WHEN type='pageview' AND client_class='human' THEN visitor_hash END) AS visitors,
        SUM(type='search') AS searches,
        SUM(type='ai_question') AS ai_questions,
        SUM(type='feedback' AND rating=1) AS positive,
        SUM(type='feedback' AND rating=-1) AS negative,
        SUM(client_class='ai_agent') AS ai_agent_requests,
        SUM(type='markdown') AS markdown_requests,
        SUM(type='api_call') AS api_calls,
        SUM(client_class='bot') AS bot_requests
       FROM analytics_events WHERE space_id=? AND created_at >= ?`,
      p,
    );
    const series = await query(
      `SELECT DATE(created_at) AS day,
        SUM(type='pageview' AND client_class='human') AS pageviews,
        COUNT(DISTINCT CASE WHEN type='pageview' AND client_class='human' THEN visitor_hash END) AS visitors,
        SUM(client_class='ai_agent') AS ai_agents,
        SUM(type='search') AS searches,
        SUM(type='ai_question') AS ai_questions
       FROM analytics_events WHERE space_id=? AND created_at >= ? GROUP BY DATE(created_at) ORDER BY day`,
      p,
    );
    const topPages = await query(
      `SELECT page_stable_id, COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS visitors FROM analytics_events
       WHERE space_id=? AND created_at >= ? AND type='pageview' AND client_class='human' AND page_stable_id IS NOT NULL
       GROUP BY page_stable_id ORDER BY views DESC LIMIT 15`,
      p,
    );
    const referrers = await query(
      `SELECT referrer, COUNT(*) AS n FROM analytics_events WHERE space_id=? AND created_at >= ? AND type='pageview' AND referrer IS NOT NULL AND referrer<>''
       GROUP BY referrer ORDER BY n DESC LIMIT 10`,
      p,
    );
    const searches = await query(
      `SELECT LOWER(query) AS q, COUNT(*) AS n, AVG(results_count) AS avg_results, SUM(results_count=0) AS no_results FROM analytics_events
       WHERE space_id=? AND created_at >= ? AND type='search' GROUP BY LOWER(query) ORDER BY n DESC LIMIT 25`,
      p,
    );
    const aiQuestions = await query(
      `SELECT query, results_count, meta, created_at FROM analytics_events WHERE space_id=? AND created_at >= ? AND type='ai_question' ORDER BY created_at DESC LIMIT 30`,
      p,
    );
    const agents = await query(
      `SELECT agent_name, COUNT(*) AS n, SUM(type='markdown') AS markdown FROM analytics_events WHERE space_id=? AND created_at >= ? AND client_class='ai_agent'
       GROUP BY agent_name ORDER BY n DESC LIMIT 15`,
      p,
    );
    const agentPages = await query(
      `SELECT page_stable_id, path, COUNT(*) AS n FROM analytics_events WHERE space_id=? AND created_at >= ? AND client_class='ai_agent'
       GROUP BY page_stable_id, path ORDER BY n DESC LIMIT 10`,
      p,
    );
    const feedback = await query(
      `SELECT page_stable_id, SUM(rating=1) AS positive, SUM(rating=-1) AS negative FROM analytics_events
       WHERE space_id=? AND created_at >= ? AND type='feedback' AND page_stable_id IS NOT NULL GROUP BY page_stable_id ORDER BY (SUM(rating=-1) - SUM(rating=1)) DESC LIMIT 15`,
      p,
    );
    const comments = await query(
      `SELECT page_stable_id, rating, comment, created_at FROM analytics_events WHERE space_id=? AND created_at >= ? AND type='feedback' AND comment IS NOT NULL ORDER BY created_at DESC LIMIT 30`,
      p,
    );
    const title = (sid: string | null) => (sid ? site.byStable.get(sid)?.title ?? '(deleted page)' : '—');
    const num = (v: unknown) => Number(v || 0);
    res.json({
      days,
      totals: Object.fromEntries(Object.entries(totals || {}).map(([k, v]) => [k, num(v)])),
      series: series.map((s) => ({
        day: new Date(s.day).toISOString().slice(0, 10),
        pageviews: num(s.pageviews),
        visitors: num(s.visitors),
        aiAgents: num(s.ai_agents),
        searches: num(s.searches),
        aiQuestions: num(s.ai_questions),
      })),
      topPages: topPages.map((t) => ({ stableId: t.page_stable_id, title: title(t.page_stable_id), path: site.byStable.get(t.page_stable_id)?.path, views: num(t.views), visitors: num(t.visitors) })),
      referrers: referrers.map((r) => ({ referrer: r.referrer, count: num(r.n) })),
      searches: searches.map((s) => ({ query: s.q, count: num(s.n), avgResults: Math.round(Number(s.avg_results || 0) * 10) / 10, noResults: num(s.no_results) })),
      aiQuestions: aiQuestions.map((q) => ({ question: q.query, sources: num(q.results_count), unanswered: !!json<any>(q.meta, {}).unanswered, at: q.created_at })),
      agents: agents.map((a) => ({ agent: a.agent_name || 'Unknown', requests: num(a.n), markdown: num(a.markdown) })),
      agentPages: agentPages.map((a) => ({ title: a.page_stable_id ? title(a.page_stable_id) : a.path, path: a.path, requests: num(a.n) })),
      feedback: feedback.map((f) => ({ stableId: f.page_stable_id, title: title(f.page_stable_id), positive: num(f.positive), negative: num(f.negative) })),
      feedbackComments: comments.map((c) => ({ title: title(c.page_stable_id), rating: c.rating, comment: c.comment, at: c.created_at })),
    });
  }),
);

insightsRouter.get(
  '/spaces/:spaceId/quality',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId);
    const branchId = typeof req.query.branchId === 'string' ? req.query.branchId : (await getMainBranch(space.id))!.id;
    const pages = await query("SELECT id, stable_id, title, description, content, updated_at, kind FROM pages WHERE branch_id=? AND space_id=? AND deleted=0 AND kind IN ('doc','api')", [branchId, space.id]);
    const ids = new Set((await query<{ stable_id: string }>('SELECT stable_id FROM pages WHERE branch_id=? AND deleted=0', [branchId])).map((r) => r.stable_id));
    const titleCount = new Map<string, number>();
    for (const p of pages) titleCount.set(p.title.toLowerCase(), (titleCount.get(p.title.toLowerCase()) || 0) + 1);
    const reports = pages.map((p) => {
      const r = checkQuality(p, json<PMNode>(p.content, emptyDoc()), { knownStableIds: ids, duplicateTitle: (titleCount.get(p.title.toLowerCase()) || 0) > 1 });
      return { pageId: p.id, stableId: p.stable_id, title: p.title, ...r };
    });
    reports.sort((a, b) => a.score - b.score);
    const avg = reports.length ? Math.round(reports.reduce((a, r) => a + r.score, 0) / reports.length) : 100;
    const byRule = new Map<string, number>();
    for (const r of reports) for (const i of r.issues) byRule.set(i.rule, (byRule.get(i.rule) || 0) + 1);
    res.json({ averageScore: avg, pages: reports, issueCounts: Object.fromEntries(byRule) });
  }),
);

/** Content gap detection: what readers look for but don't find. */
insightsRouter.get(
  '/spaces/:spaceId/gaps',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId);
    const days = rangeDays(req.query.days);
    const since = new Date(Date.now() - days * 86400_000);
    const site = await getSiteData(space);
    const zero = await query(
      `SELECT LOWER(query) AS q, COUNT(*) AS n FROM analytics_events WHERE space_id=? AND created_at>=? AND type='search' AND results_count=0
       GROUP BY LOWER(query) ORDER BY n DESC LIMIT 50`,
      [space.id, since],
    );
    const unanswered = await query(
      `SELECT query AS q, COUNT(*) AS n FROM analytics_events WHERE space_id=? AND created_at>=? AND type='ai_question' AND (results_count=0 OR meta LIKE '%"unanswered":true%')
       GROUP BY query ORDER BY n DESC LIMIT 50`,
      [space.id, since],
    );
    const unhelpful = await query(
      `SELECT page_stable_id, SUM(rating=1) AS pos, SUM(rating=-1) AS neg FROM analytics_events WHERE space_id=? AND created_at>=? AND type='feedback' AND page_stable_id IS NOT NULL
       GROUP BY page_stable_id HAVING neg >= 2 AND neg >= pos ORDER BY neg DESC LIMIT 20`,
      [space.id, since],
    );
    const viewed = new Set(
      (await query<{ page_stable_id: string }>(`SELECT DISTINCT page_stable_id FROM analytics_events WHERE space_id=? AND created_at>=? AND type='pageview' AND page_stable_id IS NOT NULL`, [space.id, since])).map((r) => r.page_stable_id),
    );
    const unvisited = site.flat.filter((p) => (p.kind === 'doc' || p.kind === 'api') && !p.hidden && !viewed.has(p.stable_id)).map((p) => ({ stableId: p.stable_id, title: p.title, path: p.path }));

    // Cluster missing-topic queries by shared significant terms.
    const queries = [...zero.map((z) => ({ q: z.q, n: Number(z.n), source: 'search' })), ...unanswered.map((u) => ({ q: u.q, n: Number(u.n), source: 'ai' }))];
    const clusters: { topic: string; queries: string[]; count: number }[] = [];
    for (const item of queries) {
      const terms = new Set(tokenize(item.q));
      const match = clusters.find((c) => tokenize(c.topic).some((t) => terms.has(t)));
      if (match) {
        match.queries.push(item.q);
        match.count += item.n;
      } else clusters.push({ topic: [...terms].slice(0, 4).join(' ') || item.q, queries: [item.q], count: item.n });
    }
    clusters.sort((a, b) => b.count - a.count);
    res.json({
      days,
      zeroResultSearches: zero.map((z) => ({ query: z.q, count: Number(z.n) })),
      unansweredQuestions: unanswered.map((u) => ({ question: u.q, count: Number(u.n) })),
      unhelpfulPages: unhelpful.map((u) => ({ stableId: u.page_stable_id, title: site.byStable.get(u.page_stable_id)?.title ?? '(deleted page)', positive: Number(u.pos), negative: Number(u.neg) })),
      unvisitedPages: unvisited.slice(0, 50),
      suggestedTopics: clusters.slice(0, 15),
    });
  }),
);

insightsRouter.post(
  '/spaces/:spaceId/gaps/suggest',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'editor');
    if (!aiEnabled()) throw badRequest('Topic suggestions need a language model. Configure AI_PROVIDER in .env.');
    const { queries } = parse(z.object({ queries: z.array(z.string().max(500)).min(1).max(100) }), req.body);
    const site = await getSiteData(space);
    const out = await chat(
      [
        { role: 'system', content: 'You are a documentation strategist. Reply with Markdown only.' },
        {
          role: 'user',
          content: `Existing pages:\n${site.flat.map((p) => `- ${p.title}`).join('\n')}\n\nReaders searched or asked for these and found nothing:\n${queries.map((q) => `- ${q}`).join('\n')}\n\nSuggest up to 8 new pages or improvements. For each give a title, which queries it addresses, and a short outline.`,
        },
      ],
      { maxTokens: 1500 },
    );
    res.json({ markdown: out });
  }),
);

// ---- AI writing -----------------------------------------------------------------------------

insightsRouter.get('/ai/status', (_req, res) => {
  res.json(aiInfo());
});

const writeSchema = z.object({
  action: z.enum(WRITE_ACTIONS),
  text: z.string().max(60000).default(''),
  language: z.string().max(50).optional(),
  prompt: z.string().max(4000).optional(),
  context: z.string().max(20000).optional(),
});

insightsRouter.post(
  '/ai/write',
  ah(async (req, res) => {
    const body = parse(writeSchema, req.body);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
    try {
      if (!aiEnabled()) {
        send({ type: 'delta', text: writeAssistFallback(body.action, body.text) });
      } else {
        for await (const chunk of writeAssistStream(body.action, body.text, body)) send({ type: 'delta', text: chunk });
      }
    } catch (err) {
      send({ type: 'error', message: err instanceof HttpError ? err.message : `AI request failed: ${(err as Error).message}` });
    }
    send({ type: 'done' });
    res.end();
  }),
);

insightsRouter.post(
  '/pages/:pageId/translate',
  ah(async (req, res) => {
    const page = await one('SELECT * FROM pages WHERE id=? AND deleted=0', [req.params.pageId]);
    if (!page) throw new HttpError(404, 'Page not found');
    const { space, role } = await requireSpace(req, page.space_id, 'editor');
    const branch = await one('SELECT * FROM branches WHERE id=?', [page.branch_id]);
    if (!canEditBranch(space, branch, role)) throw new HttpError(409, 'This branch is locked for editing');
    const { language } = parse(z.object({ language: z.string().trim().min(2).max(50) }), req.body);
    const translated = await translateDoc(json<PMNode>(page.content, emptyDoc()), language);
    const title = (await chat([{ role: 'user', content: `Translate this page title into ${language}. Reply with the title only:\n${page.title}` }], { maxTokens: 60 })).replace(/^["']|["']$/g, '').split('\n')[0] || page.title;
    const created = await createPage({
      spaceId: space.id,
      branchId: page.branch_id,
      title: `${title}`,
      parentStableId: page.parent_stable_id,
      content: translated,
      description: page.description,
      icon: page.icon,
      position: page.position + 0.5,
      userId: req.user!.id,
    });
    res.json({ id: created.id, stableId: created.stableId });
  }),
);

insightsRouter.post(
  '/pages/:pageId/ai-review',
  ah(async (req, res) => {
    const page = await one('SELECT * FROM pages WHERE id=? AND deleted=0', [req.params.pageId]);
    if (!page) throw new HttpError(404, 'Page not found');
    await requireSpace(req, page.space_id, 'reader');
    if (!aiEnabled()) throw badRequest('AI review needs a language model. The rule-based quality check is available without one.');
    const md = toMarkdown(json<PMNode>(page.content, emptyDoc()));
    const out = await chat(
      [
        { role: 'system', content: 'You are a meticulous technical editor. Reply in Markdown.' },
        {
          role: 'user',
          content: `Review this documentation page titled "${page.title}". List concrete issues under: Accuracy & clarity, Missing information, Structure, Style & tone, Examples. Quote the problem text and propose a fix for each. End with a score from 1-10.\n\n${md.slice(0, 30000)}`,
        },
      ],
      { maxTokens: 1800 },
    );
    res.json({ markdown: out });
  }),
);

insightsRouter.post(
  '/spaces/:spaceId/branches/:branchId/ai-generate',
  ah(async (req, res) => {
    const { space, role } = await requireSpace(req, req.params.spaceId, 'editor');
    const branch = await one('SELECT * FROM branches WHERE id=? AND space_id=?', [req.params.branchId, space.id]);
    if (!branch || !canEditBranch(space, branch, role)) throw new HttpError(409, 'This branch is locked for editing');
    if (!aiEnabled()) throw badRequest('Page generation needs a language model. Configure AI_PROVIDER in .env.');
    const body = parse(z.object({ prompt: z.string().trim().min(3).max(4000), parentStableId: z.string().max(36).nullable().optional() }), req.body);
    let md = '';
    for await (const c of writeAssistStream('generate', '', { prompt: body.prompt })) md += c;
    md = md.replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/, '$1');
    const h1 = /^#\s+(.+)\n/.exec(md.trimStart());
    const title = h1 ? h1[1].trim() : body.prompt.slice(0, 80);
    if (h1) md = md.trimStart().slice(h1[0].length);
    const created = await createPage({ spaceId: space.id, branchId: branch.id, title, parentStableId: body.parentStableId ?? null, content: markdownToJson(md), userId: req.user!.id });
    res.json({ id: created.id, stableId: created.stableId });
  }),
);
