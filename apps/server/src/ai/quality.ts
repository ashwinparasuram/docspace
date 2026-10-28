import { type PMNode, extractText, inlineText, walk } from '../content/prosemirror.js';

export interface QualityIssue {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  excerpt?: string;
}

export interface QualityReport {
  score: number;
  words: number;
  readingMinutes: number;
  readability: number;
  issues: QualityIssue[];
}

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  const m = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, m?.length ?? 1);
}

/** Flesch reading ease (0-100, higher = easier). */
export function readability(text: string): number {
  const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) || []).length);
  const words = text.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length < 20) return 100;
  const syllables = words.reduce((a, w) => a + countSyllables(w), 0);
  const score = 206.835 - 1.015 * (words.length / sentences) - 84.6 * (syllables / words.length);
  return Math.round(Math.max(0, Math.min(100, score)));
}

/** Rule-based documentation linter. Runs fully offline. */
export function checkQuality(
  page: { title: string; description?: string | null; updated_at?: Date | string; kind?: string },
  doc: PMNode,
  ctx: { knownStableIds?: Set<string>; duplicateTitle?: boolean } = {},
): QualityReport {
  const issues: QualityIssue[] = [];
  const text = extractText(doc);
  const words = text.split(/\s+/).filter(Boolean).length;
  const score = readability(text);

  if (page.kind === 'doc' || !page.kind) {
    if (words === 0) issues.push({ rule: 'empty-page', severity: 'error', message: 'This page has no content.' });
    else if (words < 50) issues.push({ rule: 'thin-content', severity: 'warning', message: `Only ${words} words — consider expanding this page.` });
  }
  if (!page.description) issues.push({ rule: 'missing-description', severity: 'info', message: 'Add a page description to improve SEO and search snippets.' });
  if (ctx.duplicateTitle) issues.push({ rule: 'duplicate-title', severity: 'warning', message: `Another page is also titled "${page.title}".` });
  if (page.updated_at && Date.now() - new Date(page.updated_at).getTime() > 180 * 86400_000) {
    issues.push({ rule: 'stale-content', severity: 'info', message: 'Not updated in over 6 months — verify it is still accurate.' });
  }

  let lastLevel = 1;
  walk(doc, (n) => {
    if (n.type === 'heading') {
      const level = n.attrs?.level || 1;
      const t = inlineText(n);
      if (level > lastLevel + 1) issues.push({ rule: 'heading-skip', severity: 'warning', message: `Heading level jumps from H${lastLevel} to H${level}.`, excerpt: t });
      if (!t.trim()) issues.push({ rule: 'empty-heading', severity: 'warning', message: 'Empty heading.' });
      lastLevel = level;
    }
    if (n.type === 'paragraph') {
      const t = inlineText(n);
      const wc = t.split(/\s+/).filter(Boolean).length;
      if (wc > 150) issues.push({ rule: 'long-paragraph', severity: 'info', message: `Paragraph with ${wc} words — split it for readability.`, excerpt: t.slice(0, 80) });
      for (const sentence of t.split(/(?<=[.!?])\s+/)) {
        const sw = sentence.split(/\s+/).filter(Boolean).length;
        if (sw > 40) issues.push({ rule: 'long-sentence', severity: 'info', message: `Sentence with ${sw} words.`, excerpt: sentence.slice(0, 80) });
      }
      const rep = /\b(\w+)\s+\1\b/i.exec(t);
      if (rep && isNaN(Number(rep[1]))) issues.push({ rule: 'repeated-word', severity: 'warning', message: `Repeated word "${rep[1]}".`, excerpt: rep[0] });
      const todo = /\b(TODO|FIXME|TBD|XXX|lorem ipsum)\b/i.exec(t);
      if (todo) issues.push({ rule: 'placeholder', severity: 'error', message: `Placeholder text "${todo[1]}" found.`, excerpt: t.slice(0, 80) });
    }
    if (n.type === 'image' && !n.attrs?.alt) issues.push({ rule: 'image-alt', severity: 'warning', message: 'Image is missing alt text (accessibility).', excerpt: String(n.attrs?.src || '').slice(0, 80) });
    if (n.type === 'codeBlock' && !n.attrs?.language) issues.push({ rule: 'code-language', severity: 'info', message: 'Code block has no language set (no syntax highlighting).' });
    for (const m of n.marks || []) {
      if (m.type !== 'link') continue;
      const href = String(m.attrs?.href || '');
      if (href.startsWith('page://') && ctx.knownStableIds && !ctx.knownStableIds.has(href.slice(7))) {
        issues.push({ rule: 'broken-link', severity: 'error', message: 'Link points to a page that no longer exists.', excerpt: n.text });
      } else if (href.startsWith('http://') && !/localhost|127\.0\.0\.1/.test(href)) {
        issues.push({ rule: 'insecure-link', severity: 'info', message: 'Link uses http:// instead of https://.', excerpt: href });
      } else if (!href || href === '#') {
        issues.push({ rule: 'empty-link', severity: 'warning', message: 'Link has no destination.', excerpt: n.text });
      }
    }
  });
  if (words > 200 && score < 30) issues.push({ rule: 'readability', severity: 'warning', message: `Hard to read (Flesch score ${score}). Use shorter sentences and simpler words.` });

  const penalty = issues.reduce((a, i) => a + (i.severity === 'error' ? 15 : i.severity === 'warning' ? 6 : 2), 0);
  return {
    score: Math.max(0, 100 - penalty),
    words,
    readingMinutes: Math.max(1, Math.round(words / 220)),
    readability: score,
    issues: dedupe(issues),
  };
}

function dedupe(issues: QualityIssue[]): QualityIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.rule}|${i.excerpt || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
