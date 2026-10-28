import * as Y from 'yjs';
import { marked, type Token, type Tokens } from 'marked';

/** ProseMirror/TipTap JSON document model shared by the editor, renderer, search and AI. */
export interface PMMark {
  type: string;
  attrs?: Record<string, any>;
}
export interface PMNode {
  type: string;
  attrs?: Record<string, any>;
  content?: PMNode[];
  marks?: PMMark[];
  text?: string;
}

export const emptyDoc = (): PMNode => ({ type: 'doc', content: [{ type: 'paragraph' }] });

const BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem', 'taskItem', 'tableCell', 'tableHeader',
  'callout', 'expandable', 'tab', 'mermaid', 'image', 'horizontalRule', 'tableRow',
]);

/** Plain text, one line per block. Used for search indexing, diffs, AI context. */
export function extractText(node: PMNode | null | undefined): string {
  if (!node) return '';
  const out: string[] = [];
  const walk = (n: PMNode, buf: string[]) => {
    if (n.type === 'text') {
      buf.push(n.text || '');
      return;
    }
    if (n.type === 'hardBreak') {
      buf.push('\n');
      return;
    }
    if (n.type === 'mermaid') {
      out.push(String(n.attrs?.code || ''));
      return;
    }
    if (n.type === 'image') {
      if (n.attrs?.alt) out.push(String(n.attrs.alt));
      return;
    }
    if (n.type === 'apiOperation') {
      out.push(`${String(n.attrs?.method || '').toUpperCase()} ${n.attrs?.path || ''}`);
      return;
    }
    if (n.type === 'tab' && n.attrs?.title) out.push(String(n.attrs.title));
    if (n.type === 'expandable' && n.attrs?.title) out.push(String(n.attrs.title));
    const isBlock = BLOCK_TYPES.has(n.type);
    if (isBlock && n.content?.some((c) => c.type === 'text' || c.type === 'hardBreak')) {
      const line: string[] = [];
      for (const c of n.content || []) walk(c, line);
      out.push(line.join(''));
    } else {
      for (const c of n.content || []) walk(c, buf);
    }
  };
  walk(node, out);
  return out
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'section'
  );
}

export function inlineText(n: PMNode): string {
  if (n.type === 'text') return n.text || '';
  return (n.content || []).map(inlineText).join('');
}

export interface Heading {
  level: number;
  text: string;
  id: string;
}

/** Headings with unique anchor ids; the renderer uses the same algorithm so links stay stable. */
export function collectHeadings(doc: PMNode): Heading[] {
  const used = new Map<string, number>();
  const result: Heading[] = [];
  const walk = (n: PMNode) => {
    if (n.type === 'heading') {
      const text = inlineText(n);
      result.push({ level: n.attrs?.level || 1, text, id: uniqueId(slugifyHeading(text), used) });
      return;
    }
    n.content?.forEach(walk);
  };
  walk(doc);
  return result;
}

export function uniqueId(base: string, used: Map<string, number>): string {
  const n = used.get(base) ?? 0;
  used.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

// ---------------------------------------------------------------------------------------------
// Yjs <-> ProseMirror JSON (compatible with y-prosemirror's encoding used by TipTap Collaboration)
// ---------------------------------------------------------------------------------------------

export const YJS_FIELD = 'default';

export function yFragmentToJson(fragment: Y.XmlFragment): PMNode {
  return { type: 'doc', content: fragment.toArray().flatMap(yItemToJson) };
}

function yItemToJson(item: Y.XmlElement | Y.XmlText | Y.XmlHook): PMNode[] {
  if (item instanceof Y.XmlText) {
    const delta = item.toDelta() as { insert: unknown; attributes?: Record<string, any> }[];
    return delta
      .filter((d) => typeof d.insert === 'string' && d.insert.length > 0)
      .map((d) => {
        const node: PMNode = { type: 'text', text: d.insert as string };
        if (d.attributes && Object.keys(d.attributes).length) {
          node.marks = Object.entries(d.attributes).map(([key, attrs]) => {
            const type = key.replace(/--[a-zA-Z0-9+/=]+$/, '');
            return attrs && typeof attrs === 'object' && Object.keys(attrs).length ? { type, attrs } : { type };
          });
        }
        return node;
      });
  }
  if (item instanceof Y.XmlElement) {
    const attrs = item.getAttributes() as Record<string, any>;
    const node: PMNode = { type: item.nodeName };
    if (Object.keys(attrs).length) node.attrs = attrs;
    const children = item.toArray().flatMap((c) => yItemToJson(c as any));
    if (children.length) node.content = children;
    return [node];
  }
  return [];
}

/** Replace a fragment's content with a ProseMirror JSON document. */
export function jsonToYFragment(fragment: Y.XmlFragment, doc: PMNode) {
  if (fragment.length) fragment.delete(0, fragment.length);
  const nodes = (doc.content || []).map(jsonToYItem).filter(Boolean) as (Y.XmlElement | Y.XmlText)[];
  if (nodes.length) fragment.insert(0, nodes);
}

function jsonToYItem(node: PMNode): Y.XmlElement | Y.XmlText | null {
  if (node.type === 'text') return null;
  const el = new Y.XmlElement(node.type);
  for (const [k, v] of Object.entries(node.attrs || {})) {
    if (v !== null && v !== undefined) el.setAttribute(k, v as any);
  }
  const children: (Y.XmlElement | Y.XmlText)[] = [];
  let pendingText: PMNode[] = [];
  const flushText = () => {
    if (!pendingText.length) return;
    const t = new Y.XmlText();
    const delta = pendingText.map((tn) => {
      const attributes: Record<string, any> = {};
      for (const m of tn.marks || []) attributes[m.type] = m.attrs || {};
      return Object.keys(attributes).length ? { insert: tn.text || '', attributes } : { insert: tn.text || '' };
    });
    t.applyDelta(delta);
    children.push(t);
    pendingText = [];
  };
  for (const c of node.content || []) {
    if (c.type === 'text') pendingText.push(c);
    else {
      flushText();
      const item = jsonToYItem(c);
      if (item) children.push(item);
    }
  }
  flushText();
  if (children.length) el.insert(0, children);
  return el;
}

export function jsonToYUpdate(doc: PMNode): Uint8Array {
  const ydoc = new Y.Doc();
  ydoc.transact(() => jsonToYFragment(ydoc.getXmlFragment(YJS_FIELD), doc));
  return Y.encodeStateAsUpdate(ydoc);
}

// ---------------------------------------------------------------------------------------------
// ProseMirror JSON -> Markdown
// ---------------------------------------------------------------------------------------------

export interface MarkdownContext {
  resolvePageLink?: (stableId: string) => string | null;
  resolveReusable?: (id: string) => PMNode | null;
}

export function toMarkdown(doc: PMNode, ctx: MarkdownContext = {}): string {
  return blocksToMd(doc.content || [], ctx, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function blocksToMd(nodes: PMNode[], ctx: MarkdownContext, indent: string): string {
  return nodes.map((n) => blockToMd(n, ctx, indent)).filter((s) => s !== null).join('\n\n');
}

function inlineToMd(nodes: PMNode[] = [], ctx: MarkdownContext): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '  \n';
      if (n.type !== 'text') return '';
      let t = n.text || '';
      const marks = n.marks || [];
      const has = (m: string) => marks.find((x) => x.type === m);
      if (has('code')) t = '`' + t + '`';
      else t = t.replace(/([*_`[\]\\])/g, '\\$1');
      if (has('bold')) t = `**${t}**`;
      if (has('italic')) t = `_${t}_`;
      if (has('strike')) t = `~~${t}~~`;
      if (has('highlight')) t = `==${t}==`;
      const link = has('link');
      if (link) {
        let href = String(link.attrs?.href || '');
        if (href.startsWith('page://') && ctx.resolvePageLink) href = ctx.resolvePageLink(href.slice(7)) || href;
        t = `[${t}](${href})`;
      }
      return t;
    })
    .join('');
}

function blockToMd(n: PMNode, ctx: MarkdownContext, indent: string): string {
  switch (n.type) {
    case 'paragraph':
      return inlineToMd(n.content, ctx);
    case 'heading':
      return `${'#'.repeat(n.attrs?.level || 1)} ${inlineToMd(n.content, ctx)}`;
    case 'blockquote':
      return blocksToMd(n.content || [], ctx, '')
        .split('\n')
        .map((l) => `> ${l}`.trimEnd())
        .join('\n');
    case 'codeBlock':
      return '```' + (n.attrs?.language || '') + '\n' + inlineText(n) + '\n```';
    case 'mermaid':
      return '```mermaid\n' + String(n.attrs?.code || '') + '\n```';
    case 'horizontalRule':
      return '---';
    case 'image':
      return `![${n.attrs?.alt || ''}](${n.attrs?.src || ''}${n.attrs?.title ? ` "${n.attrs.title}"` : ''})`;
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      let i = Number(n.attrs?.start || 1);
      return (n.content || [])
        .map((item) => {
          const bullet =
            n.type === 'orderedList' ? `${i++}.` : n.type === 'taskList' ? `- [${item.attrs?.checked ? 'x' : ' '}]` : '-';
          const body = blocksToMd(item.content || [], ctx, indent + '  ');
          const lines = body.split('\n');
          return `${bullet} ${lines[0]}${lines.length > 1 ? '\n' + lines.slice(1).map((l) => (l ? '   ' + l : l)).join('\n') : ''}`;
        })
        .join('\n');
    }
    case 'table': {
      const rows = (n.content || []).map((row) =>
        (row.content || []).map((cell) => blocksToMd(cell.content || [], ctx, '').replace(/\n+/g, ' ').replace(/\|/g, '\\|')),
      );
      if (!rows.length) return '';
      const cols = Math.max(...rows.map((r) => r.length));
      const pad = (r: string[]) => [...r, ...Array(cols - r.length).fill('')];
      const lines = [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(cols).fill('---').join(' | ')} |`];
      for (const r of rows.slice(1)) lines.push(`| ${pad(r).join(' | ')} |`);
      return lines.join('\n');
    }
    case 'callout': {
      const kind = String(n.attrs?.type || 'info');
      const map: Record<string, string> = { info: 'NOTE', success: 'TIP', warning: 'WARNING', danger: 'CAUTION' };
      const body = blocksToMd(n.content || [], ctx, '');
      return [`> [!${map[kind] || 'NOTE'}]`, ...body.split('\n').map((l) => `> ${l}`.trimEnd())].join('\n');
    }
    case 'expandable':
      return `<details>\n<summary>${n.attrs?.title || 'Details'}</summary>\n\n${blocksToMd(n.content || [], ctx, '')}\n\n</details>`;
    case 'tabs':
      return (n.content || [])
        .map((tab) => `**${tab.attrs?.title || 'Tab'}**\n\n${blocksToMd(tab.content || [], ctx, '')}`)
        .join('\n\n');
    case 'reusableBlock': {
      const content = ctx.resolveReusable?.(String(n.attrs?.blockId));
      return content ? blocksToMd(content.content || [], ctx, indent) : '';
    }
    case 'apiOperation':
      return `**\`${String(n.attrs?.method || 'GET').toUpperCase()} ${n.attrs?.path || ''}\`**`;
    case 'embed':
      return `[${n.attrs?.title || n.attrs?.src || 'Embedded file'}](${n.attrs?.src || ''})`;
    default:
      return n.content ? blocksToMd(n.content, ctx, indent) : '';
  }
}

// ---------------------------------------------------------------------------------------------
// Markdown -> ProseMirror JSON (GFM + GitHub alerts + mermaid fences + hint tags)
// ---------------------------------------------------------------------------------------------

export function markdownToJson(markdown: string): PMNode {
  // style {% hint style="info" %} ... {% endhint %} -> GitHub alert syntax.
  const md = markdown.replace(/\{%\s*hint\s+style="(\w+)"\s*%\}([\s\S]*?)\{%\s*endhint\s*%\}/g, (_m, style: string, body: string) => {
    const map: Record<string, string> = { info: 'NOTE', success: 'TIP', warning: 'WARNING', danger: 'CAUTION' };
    return `> [!${map[style] || 'NOTE'}]\n` + body.trim().split('\n').map((l) => `> ${l}`).join('\n');
  });
  const tokens = marked.lexer(md, { gfm: true });
  const content = tokensToBlocks(tokens);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

function tokensToBlocks(tokens: Token[]): PMNode[] {
  const out: PMNode[] = [];
  for (const t of tokens) out.push(...tokenToBlocks(t));
  return out;
}

function paragraphFromInline(tokens: Token[] | undefined): PMNode[] {
  const inline = inlineTokens(tokens || [], []);
  // Hoist images into their own block nodes (TipTap images are blocks).
  const result: PMNode[] = [];
  let cur: PMNode[] = [];
  for (const n of inline) {
    if (n.type === 'image') {
      if (cur.length) result.push({ type: 'paragraph', content: cur });
      cur = [];
      result.push(n);
    } else cur.push(n);
  }
  if (cur.length) result.push({ type: 'paragraph', content: cur });
  return result;
}

const ALERT_MAP: Record<string, string> = { NOTE: 'info', TIP: 'success', IMPORTANT: 'info', WARNING: 'warning', CAUTION: 'danger' };

function tokenToBlocks(t: Token): PMNode[] {
  switch (t.type) {
    case 'space':
      return [];
    case 'heading':
      return [{ type: 'heading', attrs: { level: Math.min(6, (t as Tokens.Heading).depth) }, content: inlineTokens((t as Tokens.Heading).tokens, []) }];
    case 'paragraph':
      return paragraphFromInline((t as Tokens.Paragraph).tokens);
    case 'text': {
      const tt = t as Tokens.Text;
      return paragraphFromInline(tt.tokens || [{ type: 'text', raw: tt.raw, text: tt.text } as Token]);
    }
    case 'code': {
      const c = t as Tokens.Code;
      if (c.lang === 'mermaid') return [{ type: 'mermaid', attrs: { code: c.text } }];
      return [{ type: 'codeBlock', attrs: { language: c.lang || null }, content: c.text ? [{ type: 'text', text: c.text }] : undefined }];
    }
    case 'blockquote': {
      const b = t as Tokens.Blockquote;
      const alert = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/i.exec(b.text);
      if (alert) {
        const inner = markdownToJson(b.text.slice(alert[0].length)).content || [];
        return [{ type: 'callout', attrs: { type: ALERT_MAP[alert[1].toUpperCase()] }, content: inner.length ? inner : [{ type: 'paragraph' }] }];
      }
      const inner = tokensToBlocks(b.tokens);
      return [{ type: 'blockquote', content: inner.length ? inner : [{ type: 'paragraph' }] }];
    }
    case 'hr':
      return [{ type: 'horizontalRule' }];
    case 'list': {
      const l = t as Tokens.List;
      const isTask = l.items.some((i) => i.task);
      const items: PMNode[] = l.items.map((item) => {
        const children = item.tokens.filter((x) => x.type !== 'checkbox');
        let blocks = tokensToBlocks(children);
        if (!blocks.length || blocks[0].type !== 'paragraph') blocks = [{ type: 'paragraph' }, ...blocks];
        return isTask ? { type: 'taskItem', attrs: { checked: !!item.checked }, content: blocks } : { type: 'listItem', content: blocks };
      });
      if (isTask) return [{ type: 'taskList', content: items }];
      return [l.ordered ? { type: 'orderedList', attrs: { start: Number(l.start) || 1 }, content: items } : { type: 'bulletList', content: items }];
    }
    case 'table': {
      const tb = t as Tokens.Table;
      const cell = (c: Tokens.TableCell, header: boolean): PMNode => ({
        type: header ? 'tableHeader' : 'tableCell',
        attrs: { colspan: 1, rowspan: 1, colwidth: null },
        content: [{ type: 'paragraph', content: inlineTokens(c.tokens, []) }],
      });
      return [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: tb.header.map((h) => cell(h, true)) },
            ...tb.rows.map((r) => ({ type: 'tableRow', content: r.map((c) => cell(c, false)) })),
          ],
        },
      ];
    }
    case 'html': {
      const h = t as Tokens.HTML;
      const details = /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/i.exec(h.raw);
      if (details) {
        const inner = markdownToJson(details[2]).content || [];
        return [{ type: 'expandable', attrs: { title: details[1].replace(/<[^>]+>/g, '').trim() }, content: inner }];
      }
      const text = h.raw.replace(/<[^>]+>/g, '').trim();
      return text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : [];
    }
    default:
      return [];
  }
}

function inlineTokens(tokens: Token[], marks: PMMark[]): PMNode[] {
  const out: PMNode[] = [];
  const pushText = (text: string, m: PMMark[]) => {
    if (!text) return;
    const node: PMNode = { type: 'text', text };
    if (m.length) node.marks = m;
    out.push(node);
  };
  for (const t of tokens) {
    switch (t.type) {
      case 'text': {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) out.push(...inlineTokens(tt.tokens, marks));
        else {
          // ==highlight== is not part of GFM; support it explicitly.
          const parts = decodeEntities(tt.text).split(/(==[^=]+==)/g);
          for (const p of parts) {
            if (/^==[^=]+==$/.test(p)) pushText(p.slice(2, -2), [...marks, { type: 'highlight' }]);
            else pushText(p, marks);
          }
        }
        break;
      }
      case 'escape':
        pushText((t as Tokens.Escape).text, marks);
        break;
      case 'strong':
        out.push(...inlineTokens((t as Tokens.Strong).tokens, [...marks, { type: 'bold' }]));
        break;
      case 'em':
        out.push(...inlineTokens((t as Tokens.Em).tokens, [...marks, { type: 'italic' }]));
        break;
      case 'del':
        out.push(...inlineTokens((t as Tokens.Del).tokens, [...marks, { type: 'strike' }]));
        break;
      case 'codespan':
        pushText(decodeEntities((t as Tokens.Codespan).text), [...marks, { type: 'code' }]);
        break;
      case 'link': {
        const l = t as Tokens.Link;
        out.push(...inlineTokens(l.tokens, [...marks, { type: 'link', attrs: { href: l.href, target: null } }]));
        break;
      }
      case 'image': {
        const i = t as Tokens.Image;
        out.push({ type: 'image', attrs: { src: i.href, alt: i.text || null, title: i.title || null } });
        break;
      }
      case 'br':
        out.push({ type: 'hardBreak' });
        break;
      case 'html':
        pushText((t as Tokens.HTML).text.replace(/<[^>]+>/g, ''), marks);
        break;
      default:
        if ('text' in t && typeof (t as any).text === 'string') pushText((t as any).text, marks);
    }
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Walk every node in a document. */
export function walk(node: PMNode, fn: (n: PMNode, parent: PMNode | null) => void, parent: PMNode | null = null) {
  fn(node, parent);
  node.content?.forEach((c) => walk(c, fn, node));
}
