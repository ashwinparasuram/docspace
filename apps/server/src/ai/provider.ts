import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Pluggable, self-hosted AI. Supported backends:
 *  - ollama: Ollama on your own machine (http://127.0.0.1:11434)
 *  - openai: any OpenAI-compatible server you run (LM Studio, llama.cpp server, vLLM, LocalAI)
 *  - none:   built-in non-LLM fallbacks (extractive answers, heuristic summaries, local embeddings)
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const aiEnabled = () => config.ai.provider !== 'none';

export function aiInfo() {
  return {
    provider: config.ai.provider,
    chatModel: aiEnabled() ? config.ai.chatModel : null,
    embedModel: config.ai.embedModel || null,
    llm: aiEnabled(),
  };
}

export async function chat(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
  let out = '';
  for await (const chunk of chatStream(messages, opts)) out += chunk;
  return out.trim();
}

export async function* chatStream(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {},
): AsyncGenerator<string> {
  if (!aiEnabled()) throw new Error('No AI model configured. Set AI_PROVIDER in .env (ollama or openai-compatible).');
  const base = config.ai.baseUrl.replace(/\/$/, '');
  if (config.ai.provider === 'ollama') {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.ai.chatModel,
        messages,
        stream: true,
        options: { temperature: opts.temperature ?? 0.3, num_predict: opts.maxTokens ?? 1024 },
      }),
    });
    if (!res.ok || !res.body) throw new Error(`AI backend error ${res.status}: ${await res.text().catch(() => '')}`);
    for await (const line of readLines(res.body)) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.message?.content) yield data.message.content as string;
      } catch {
        /* ignore partial lines */
      }
    }
    return;
  }
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.ai.apiKey ? { authorization: `Bearer ${config.ai.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.ai.chatModel,
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 1024,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`AI backend error ${res.status}: ${await res.text().catch(() => '')}`);
  for await (const line of readLines(res.body)) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    const payload = l.slice(5).trim();
    if (payload === '[DONE]') return;
    try {
      const data = JSON.parse(payload);
      const delta = data.choices?.[0]?.delta?.content;
      if (delta) yield delta as string;
    } catch {
      /* ignore */
    }
  }
}

async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, idx);
      buf = buf.slice(idx + 1);
    }
  }
  if (buf) yield buf;
}

// ---------------------------------------------------------------------------------------------
// Embeddings: model embeddings when configured, otherwise a local hashed n-gram embedding that
// captures lexical/sub-word similarity (handles plurals, typos, word order) with zero dependencies.
// ---------------------------------------------------------------------------------------------

export const LOCAL_EMBED_MODEL = 'local-hash-384';
const LOCAL_DIMS = 384;

export function embedModelName(): string {
  return aiEnabled() && config.ai.embedModel ? config.ai.embedModel : LOCAL_EMBED_MODEL;
}

const STOPWORDS = new Set(
  'a an and are as at be by for from has have how i in is it its of on or that the this to was what when where which who why will with you your can do does not'.split(' '),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function stem(w: string): string {
  return w.replace(/(ing|edly|ed|ies|es|s|ly)$/, '') || w;
}

export function localEmbed(text: string): number[] {
  const v = new Float32Array(LOCAL_DIMS);
  const words = tokenize(text);
  const add = (feature: string, weight: number) => {
    const h = fnv1a(feature);
    v[h % LOCAL_DIMS] += (h & 0x80000000 ? -1 : 1) * weight;
  };
  for (let i = 0; i < words.length; i++) {
    const w = stem(words[i]);
    add(`w:${w}`, 1);
    const padded = `^${w}$`;
    for (let j = 0; j < padded.length - 2; j++) add(`t:${padded.slice(j, j + 3)}`, 0.35);
    if (i + 1 < words.length) add(`b:${w}_${stem(words[i + 1])}`, 0.5);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, (x) => Math.round((x / norm) * 10000) / 10000);
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (!aiEnabled() || !config.ai.embedModel) return texts.map(localEmbed);
  const base = config.ai.baseUrl.replace(/\/$/, '');
  try {
    if (config.ai.provider === 'ollama') {
      const res = await fetch(`${base}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.ai.embedModel, input: texts }),
      });
      if (!res.ok) throw new Error(`embed ${res.status}`);
      const data = (await res.json()) as { embeddings: number[][] };
      return data.embeddings.map(normalize);
    }
    const res = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(config.ai.apiKey ? { authorization: `Bearer ${config.ai.apiKey}` } : {}) },
      body: JSON.stringify({ model: config.ai.embedModel, input: texts }),
    });
    if (!res.ok) throw new Error(`embed ${res.status}`);
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data.map((d) => normalize(d.embedding));
  } catch (err) {
    logger.warn('Embedding backend failed; falling back to local embeddings', { error: (err as Error).message });
    throw err;
  }
}

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}
