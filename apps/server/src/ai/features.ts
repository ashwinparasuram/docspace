import { aiEnabled, chat, chatStream, tokenize, type ChatMessage } from './provider.js';
import type { SearchHit } from '../search/search.js';
import { type PMNode } from '../content/prosemirror.js';
import { badRequest } from '../util.js';

export const WRITE_ACTIONS = ['improve', 'fix', 'shorten', 'expand', 'summarize', 'simplify', 'professional', 'friendly', 'translate', 'continue', 'explain', 'custom', 'generate'] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number];

const STYLE =
  'You are a senior technical writer. Output GitHub-flavored Markdown only, without preamble, explanations or code fences around the whole answer.';

function instruction(action: WriteAction, opts: { language?: string; prompt?: string }): string {
  switch (action) {
    case 'improve':
      return 'Improve the writing: clearer, more concise, better structure. Keep meaning and facts.';
    case 'fix':
      return 'Fix spelling, grammar and punctuation. Change nothing else.';
    case 'shorten':
      return 'Make this significantly shorter while keeping the key information.';
    case 'expand':
      return 'Expand this with more detail, examples and explanation, staying accurate.';
    case 'summarize':
      return 'Summarize this in a few sentences or a short bullet list.';
    case 'simplify':
      return 'Rewrite using simpler words and shorter sentences for beginners.';
    case 'professional':
      return 'Rewrite in a professional, formal tone.';
    case 'friendly':
      return 'Rewrite in a friendly, approachable tone.';
    case 'translate':
      return `Translate into ${opts.language || 'Spanish'}. Preserve Markdown formatting, code, URLs and product names.`;
    case 'continue':
      return 'Continue writing from where the text ends, in the same style. Output only the continuation.';
    case 'explain':
      return 'Explain what this means in plain language.';
    case 'generate':
      return `Write complete documentation for the following request. Use headings, lists, code examples and callouts where useful.\nRequest: ${opts.prompt || ''}`;
    case 'custom':
      return opts.prompt || 'Improve this.';
  }
}

export function writeAssistStream(action: WriteAction, text: string, opts: { language?: string; prompt?: string; context?: string } = {}) {
  const messages: ChatMessage[] = [
    { role: 'system', content: STYLE },
    {
      role: 'user',
      content:
        (opts.context ? `Page context (for reference only):\n"""\n${opts.context.slice(0, 4000)}\n"""\n\n` : '') +
        `${instruction(action, opts)}\n\n` +
        (action === 'generate' && !text ? '' : `Text:\n"""\n${text}\n"""`),
    },
  ];
  return chatStream(messages, { temperature: action === 'fix' ? 0.1 : 0.4, maxTokens: action === 'generate' || action === 'expand' ? 2000 : 1200 });
}

/** Offline fallbacks so writing tools still do something useful without a model. */
export function writeAssistFallback(action: WriteAction, text: string): string {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter(Boolean);
  switch (action) {
    case 'fix':
      return text
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+([,.!?;:])/g, '$1')
        .replace(/\b(\w+)\s+\1\b/gi, '$1')
        .replace(/(^|[.!?]\s+)([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())
        .replace(/\bi\b/g, 'I');
    case 'summarize':
    case 'shorten': {
      if (sentences.length <= 2) return text;
      const freq = new Map<string, number>();
      for (const w of tokenize(text)) freq.set(w, (freq.get(w) || 0) + 1);
      const scored = sentences.map((s, i) => ({
        s,
        i,
        score: tokenize(s).reduce((a, w) => a + (freq.get(w) || 0), 0) / Math.sqrt(tokenize(s).length + 1),
      }));
      const keep = Math.max(1, Math.round(sentences.length * (action === 'summarize' ? 0.3 : 0.6)));
      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, keep)
        .sort((a, b) => a.i - b.i)
        .map((x) => x.s)
        .join(' ');
    }
    default:
      throw badRequest('This AI action needs a language model. Configure AI_PROVIDER (e.g. a local Ollama) in .env.');
  }
}

export function buildAnswerMessages(question: string, hits: SearchHit[], history: ChatMessage[], spaceName: string): ChatMessage[] {
  const sources = hits
    .map((h, i) => `[${i + 1}] ${h.title}${h.heading ? ' › ' + h.heading : ''}\n${h.text.slice(0, 1500)}`)
    .join('\n\n---\n\n');
  return [
    {
      role: 'system',
      content:
        `You are the documentation assistant for "${spaceName}". Answer ONLY from the provided documentation sources. ` +
        'Cite sources inline like [1], [2]. If the answer is not in the sources, say you could not find it in the documentation and suggest what to search for. ' +
        'Be concise and use Markdown (lists, code blocks) when helpful.',
    },
    ...history.slice(-6),
    { role: 'user', content: `Documentation sources:\n\n${sources || '(no relevant sources found)'}\n\nQuestion: ${question}` },
  ];
}

/** Extractive answer used when no LLM is configured: the most relevant passages, quoted with sources. */
export function extractiveAnswer(question: string, hits: SearchHit[]): string {
  if (!hits.length) return "I couldn't find anything about that in the documentation. Try rephrasing or searching for a related term.";
  const qTerms = new Set(tokenize(question));
  const picked: string[] = [];
  hits.slice(0, 3).forEach((h, idx) => {
    const sentences = h.text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 20);
    const best = sentences
      .map((s) => ({ s, score: tokenize(s).filter((w) => qTerms.has(w)).length }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .filter((x) => x.score > 0)
      .map((x) => x.s.trim());
    const label = `**${h.title}${h.heading ? ` › ${h.heading}` : ''}**`;
    if (best.length) picked.push(`${label}: ${best.join(' ')} [${idx + 1}]`);
    else if (h.heading && tokenize(h.heading).some((w) => qTerms.has(w))) picked.push(`${label}: ${h.snippet} [${idx + 1}]`);
  });
  if (!picked.length) picked.push(`${hits[0].snippet} [1]`);
  return `Here's what the documentation says:\n\n${picked.map((p) => `> ${p}`).join('\n>\n')}`;
}

export async function answerConfidence(hits: SearchHit[]): Promise<number> {
  if (!hits.length) return 0;
  return Math.min(1, hits[0].score * 40);
}

/** Translate a ProseMirror document by translating text blocks in batches, preserving structure. */
export async function translateDoc(doc: PMNode, language: string): Promise<PMNode> {
  if (!aiEnabled()) throw badRequest('Translation needs a language model. Configure AI_PROVIDER (e.g. a local Ollama) in .env.');
  const clone: PMNode = JSON.parse(JSON.stringify(doc));
  const textNodes: PMNode[] = [];
  const visit = (n: PMNode, inCode: boolean) => {
    if (n.type === 'codeBlock' || n.type === 'mermaid') return;
    if (n.type === 'text' && !inCode && !(n.marks || []).some((m) => m.type === 'code') && /\p{L}/u.test(n.text || '')) textNodes.push(n);
    if (n.attrs?.title && (n.type === 'tab' || n.type === 'expandable')) textNodes.push({ type: '__attr', attrs: { node: n }, text: n.attrs.title });
    n.content?.forEach((c) => visit(c, inCode));
  };
  visit(clone, false);
  const BATCH = 40;
  for (let i = 0; i < textNodes.length; i += BATCH) {
    const batch = textNodes.slice(i, i + BATCH);
    const input = batch.map((n, j) => `${j + 1}|||${(n.text || '').replace(/\n/g, ' ')}`).join('\n');
    const out = await chat(
      [
        {
          role: 'system',
          content: `Translate each line into ${language}. Lines have the form "N|||text". Reply with exactly the same number of lines in the same "N|||translation" form. Keep leading/trailing spaces, product names, URLs and placeholders unchanged.`,
        },
        { role: 'user', content: input },
      ],
      { temperature: 0.1, maxTokens: 4000 },
    );
    const map = new Map<number, string>();
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\|\|\|(.*)$/.exec(line);
      if (m) map.set(Number(m[1]), m[2]);
    }
    batch.forEach((n, j) => {
      const t = map.get(j + 1);
      if (t === undefined) return;
      const lead = /^\s*/.exec(n.text || '')![0];
      const trail = /\s*$/.exec(n.text || '')![0];
      const value = lead + t.trim() + trail;
      if (n.type === '__attr') (n.attrs!.node as PMNode).attrs!.title = value;
      else n.text = value;
    });
  }
  return clone;
}
