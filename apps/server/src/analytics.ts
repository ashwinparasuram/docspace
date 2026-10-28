import type { Request } from 'express';
import { exec } from './db.js';
import { logger } from './logger.js';
import { clientIp, visitorHash } from './util.js';

const AI_AGENTS: [RegExp, string][] = [
  [/ChatGPT-User/i, 'ChatGPT'],
  [/OAI-SearchBot/i, 'OpenAI Search'],
  [/GPTBot/i, 'GPTBot'],
  [/Claude-User|Claude-Web|Claude-SearchBot/i, 'Claude'],
  [/ClaudeBot|anthropic-ai/i, 'ClaudeBot'],
  [/Perplexity-User|PerplexityBot/i, 'Perplexity'],
  [/Google-Extended|Gemini/i, 'Gemini'],
  [/Applebot-Extended/i, 'Apple Intelligence'],
  [/Meta-ExternalAgent|meta-externalfetcher/i, 'Meta AI'],
  [/MistralAI-User/i, 'Mistral'],
  [/cohere-ai/i, 'Cohere'],
  [/DuckAssistBot/i, 'DuckAssist'],
  [/YouBot/i, 'You.com'],
  [/CCBot/i, 'Common Crawl'],
  [/Bytespider/i, 'Bytespider'],
  [/Amazonbot/i, 'Amazonbot'],
  [/Cursor|Windsurf|Copilot|Cline|Devin|aider/i, 'Coding agent'],
];

export function classifyClient(ua: string): { clientClass: 'human' | 'bot' | 'ai_agent'; agent: string | null } {
  for (const [re, name] of AI_AGENTS) if (re.test(ua)) return { clientClass: 'ai_agent', agent: name };
  if (!ua || /bot|crawler|spider|slurp|curl|wget|python-requests|httpclient|go-http|axios|node-fetch|headless/i.test(ua)) {
    const m = /([A-Za-z-]*bot)/i.exec(ua);
    return { clientClass: 'bot', agent: m ? m[1] : ua.split('/')[0]?.slice(0, 60) || 'unknown' };
  }
  return { clientClass: 'human', agent: null };
}

interface EventInput {
  spaceId: string;
  type: 'pageview' | 'search' | 'feedback' | 'ai_question' | 'markdown' | 'api_call';
  pageStableId?: string | null;
  path?: string | null;
  query?: string | null;
  resultsCount?: number | null;
  rating?: number | null;
  comment?: string | null;
  meta?: Record<string, unknown> | null;
}

let buffer: unknown[][] = [];

/** Buffered analytics write (flushed in batches). Stores only an anonymous daily visitor hash. */
export function track(req: Request, e: EventInput) {
  const ua = String(req.headers['user-agent'] || '');
  const { clientClass, agent } = classifyClient(ua);
  let referrer = String(req.headers.referer || '');
  try {
    if (referrer && new URL(referrer).host === req.headers.host) referrer = '';
  } catch {
    referrer = '';
  }
  buffer.push([
    e.spaceId,
    e.type,
    e.pageStableId ?? null,
    e.path?.slice(0, 1000) ?? null,
    e.query?.slice(0, 1000) ?? null,
    e.resultsCount ?? null,
    e.rating ?? null,
    e.comment?.slice(0, 2000) ?? null,
    visitorHash(clientIp(req), ua),
    referrer.slice(0, 1000) || null,
    clientClass,
    agent,
    e.meta ? JSON.stringify(e.meta) : null,
  ]);
  if (buffer.length >= 200) void flush();
}

async function flush() {
  if (!buffer.length) return;
  const rows = buffer;
  buffer = [];
  try {
    await exec(
      `INSERT INTO analytics_events (space_id, type, page_stable_id, path, query, results_count, rating, comment, visitor_hash, referrer, client_class, agent_name, meta) VALUES ?`,
      [rows],
    );
  } catch (err) {
    logger.warn('analytics flush failed', { error: (err as Error).message });
  }
}

export function startAnalyticsFlusher() {
  setInterval(() => void flush(), 2000).unref();
}

export const flushAnalytics = flush;
