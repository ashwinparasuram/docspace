import hljs from 'highlight.js';
import { type PMNode, inlineText, slugifyHeading, uniqueId, walk } from '../content/prosemirror.js';
import { deref, exampleFromSchema, findOperation } from '../content/openapi.js';
import { json, query } from '../db.js';
import { escapeHtml as esc } from '../util.js';

export interface RenderContext {
  pageHref: (stableId: string) => string | null;
  reusable: Map<string, PMNode>;
  specs: Map<string, any>;
  usedIds: Map<string, number>;
  depth: number;
}

/** Load reusable blocks and OpenAPI specs referenced by a document before rendering. */
export async function prepareContext(docs: PMNode[], spaceId: string, pageHref: RenderContext['pageHref']): Promise<RenderContext> {
  const blockIds = new Set<string>();
  const specIds = new Set<string>();
  const collect = (d: PMNode) =>
    walk(d, (n) => {
      if (n.type === 'reusableBlock' && n.attrs?.blockId) blockIds.add(String(n.attrs.blockId));
      if (n.type === 'apiOperation' && n.attrs?.specId) specIds.add(String(n.attrs.specId));
    });
  docs.forEach(collect);
  const reusable = new Map<string, PMNode>();
  if (blockIds.size) {
    const rows = await query('SELECT r.id, r.content FROM reusable_blocks r JOIN spaces s ON s.org_id=r.org_id WHERE s.id=? AND r.id IN (?)', [spaceId, [...blockIds]]);
    for (const r of rows) {
      const doc = json<PMNode>(r.content, { type: 'doc', content: [] });
      reusable.set(r.id, doc);
      walk(doc, (n) => {
        if (n.type === 'apiOperation' && n.attrs?.specId) specIds.add(String(n.attrs.specId));
      });
    }
  }
  const specs = new Map<string, any>();
  if (specIds.size) {
    const rows = await query('SELECT id, spec FROM openapi_specs WHERE space_id=? AND id IN (?)', [spaceId, [...specIds]]);
    for (const r of rows) specs.set(r.id, deref(json(r.spec, {})));
  }
  return { pageHref, reusable, specs, usedIds: new Map(), depth: 0 };
}

const SAFE_URL = /^(https?:|mailto:|tel:|\/|#|\.\/|\.\.\/)/i;
function safeHref(href: string): string {
  return SAFE_URL.test(href) ? href : '#';
}

function renderInline(nodes: PMNode[] = [], ctx: RenderContext): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '<br>';
      if (n.type !== 'text') return '';
      let html = esc(n.text || '');
      const marks = [...(n.marks || [])].sort((a, b) => (a.type === 'link' ? 1 : 0) - (b.type === 'link' ? 1 : 0));
      for (const m of marks) {
        switch (m.type) {
          case 'bold':
            html = `<strong>${html}</strong>`;
            break;
          case 'italic':
            html = `<em>${html}</em>`;
            break;
          case 'underline':
            html = `<u>${html}</u>`;
            break;
          case 'strike':
            html = `<s>${html}</s>`;
            break;
          case 'code':
            html = `<code>${html}</code>`;
            break;
          case 'highlight':
            html = `<mark>${html}</mark>`;
            break;
          case 'subscript':
            html = `<sub>${html}</sub>`;
            break;
          case 'superscript':
            html = `<sup>${html}</sup>`;
            break;
          case 'link': {
            let href = String(m.attrs?.href || '');
            if (href.startsWith('page://')) href = ctx.pageHref(href.slice(7)) || '#';
            const external = /^https?:/i.test(href);
            html = `<a href="${esc(safeHref(href))}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${html}</a>`;
            break;
          }
        }
      }
      return html;
    })
    .join('');
}

const CALLOUT_ICONS: Record<string, string> = {
  info: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  success: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg>',
  warning: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  danger: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
};

export function renderBlocks(nodes: PMNode[] = [], ctx: RenderContext): string {
  return nodes.map((n) => renderBlock(n, ctx)).join('\n');
}

function renderBlock(n: PMNode, ctx: RenderContext): string {
  switch (n.type) {
    case 'paragraph': {
      const inner = renderInline(n.content, ctx);
      return inner ? `<p>${inner}</p>` : '';
    }
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level) || 2));
      const id = uniqueId(slugifyHeading(inlineText(n)), ctx.usedIds);
      return `<h${level} id="${esc(id)}" class="heading"><a class="anchor" href="#${esc(id)}" aria-hidden="true">#</a>${renderInline(n.content, ctx)}</h${level}>`;
    }
    case 'blockquote':
      return `<blockquote>${renderBlocks(n.content, ctx)}</blockquote>`;
    case 'bulletList':
      return `<ul>${renderBlocks(n.content, ctx)}</ul>`;
    case 'orderedList':
      return `<ol${n.attrs?.start && n.attrs.start !== 1 ? ` start="${Number(n.attrs.start)}"` : ''}>${renderBlocks(n.content, ctx)}</ol>`;
    case 'listItem':
      return `<li>${renderBlocks(n.content, ctx)}</li>`;
    case 'taskList':
      return `<ul class="task-list">${renderBlocks(n.content, ctx)}</ul>`;
    case 'taskItem':
      return `<li class="task-item"><input type="checkbox" disabled${n.attrs?.checked ? ' checked' : ''}><div>${renderBlocks(n.content, ctx)}</div></li>`;
    case 'codeBlock': {
      const code = inlineText(n);
      const lang = String(n.attrs?.language || '');
      let highlighted: string;
      try {
        highlighted = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : esc(code);
      } catch {
        highlighted = esc(code);
      }
      return `<div class="code-block"><div class="code-head"><span>${esc(lang || 'text')}</span><button class="copy-btn" type="button" aria-label="Copy code">Copy</button></div><pre><code class="hljs language-${esc(lang)}">${highlighted}</code></pre></div>`;
    }
    case 'horizontalRule':
      return '<hr>';
    case 'image': {
      const src = String(n.attrs?.src || '');
      if (!SAFE_URL.test(src) && !src.startsWith('data:image/')) return '';
      const caption = n.attrs?.title ? `<figcaption>${esc(n.attrs.title)}</figcaption>` : '';
      return `<figure class="image"><img src="${esc(src)}" alt="${esc(n.attrs?.alt || '')}" loading="lazy"${n.attrs?.width ? ` width="${Number(n.attrs.width)}"` : ''}>${caption}</figure>`;
    }
    case 'table':
      return `<div class="table-wrap"><table>${renderBlocks(n.content, ctx)}</table></div>`;
    case 'tableRow':
      return `<tr>${renderBlocks(n.content, ctx)}</tr>`;
    case 'tableHeader':
    case 'tableCell': {
      const tag = n.type === 'tableHeader' ? 'th' : 'td';
      const a = n.attrs || {};
      const span = `${a.colspan > 1 ? ` colspan="${Number(a.colspan)}"` : ''}${a.rowspan > 1 ? ` rowspan="${Number(a.rowspan)}"` : ''}`;
      return `<${tag}${span}>${renderBlocks(n.content, ctx)}</${tag}>`;
    }
    case 'callout': {
      const t: string = ['info', 'success', 'warning', 'danger'].includes(n.attrs?.type) ? n.attrs?.type : 'info';
      return `<div class="callout callout-${t}"><div class="callout-icon">${CALLOUT_ICONS[t]}</div><div class="callout-body">${renderBlocks(n.content, ctx)}</div></div>`;
    }
    case 'expandable':
      return `<details class="expandable"><summary>${esc(n.attrs?.title || 'Details')}</summary><div class="expandable-body">${renderBlocks(n.content, ctx)}</div></details>`;
    case 'tabs': {
      const tabs = n.content || [];
      const id = 'tabs-' + Math.random().toString(36).slice(2, 8);
      return `<div class="tabs" id="${id}"><div class="tab-list" role="tablist">${tabs
        .map((t, i) => `<button type="button" role="tab" class="tab-btn${i === 0 ? ' active' : ''}" data-tab="${i}">${esc(t.attrs?.title || `Tab ${i + 1}`)}</button>`)
        .join('')}</div>${tabs.map((t, i) => `<div class="tab-panel${i === 0 ? ' active' : ''}" data-panel="${i}">${renderBlocks(t.content, ctx)}</div>`).join('')}</div>`;
    }
    case 'mermaid':
      return `<div class="mermaid-block"><pre class="mermaid">${esc(n.attrs?.code || '')}</pre></div>`;
    case 'embed': {
      const src = String(n.attrs?.src || '');
      if (!SAFE_URL.test(src)) return '';
      const kind = n.attrs?.kind || 'file';
      if (kind === 'video') return `<figure class="embed"><video src="${esc(src)}" controls preload="metadata"></video></figure>`;
      if (kind === 'audio') return `<figure class="embed"><audio src="${esc(src)}" controls></audio></figure>`;
      if (kind === 'iframe') return `<figure class="embed embed-frame"><iframe src="${esc(src)}" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups" title="${esc(n.attrs?.title || 'Embedded content')}"></iframe></figure>`;
      return `<a class="file-card" href="${esc(src)}" download><span class="file-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg></span><span><strong>${esc(n.attrs?.title || 'Download file')}</strong><small>${esc(n.attrs?.size ? formatBytes(Number(n.attrs.size)) : '')}</small></span></a>`;
    }
    case 'reusableBlock': {
      if (ctx.depth > 2) return '';
      const doc = ctx.reusable.get(String(n.attrs?.blockId));
      if (!doc) return '';
      ctx.depth++;
      const html = renderBlocks(doc.content, ctx);
      ctx.depth--;
      return `<div class="reusable">${html}</div>`;
    }
    case 'apiOperation':
      return renderApiOperation(n, ctx);
    default:
      return n.content ? renderBlocks(n.content, ctx) : '';
  }
}

function formatBytes(n: number): string {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function md(text: string | undefined): string {
  // Lightweight inline Markdown for OpenAPI descriptions (code, bold, links, paragraphs).
  if (!text) return '';
  return text
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p>${esc(p)
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')}</p>`,
    )
    .join('');
}

function schemaType(s: any): string {
  if (!s) return 'any';
  if (s.$circular) return s.title || 'object';
  if (s.type === 'array') return `${schemaType(s.items)}[]`;
  if (s.oneOf) return s.oneOf.map(schemaType).join(' | ');
  if (s.anyOf) return s.anyOf.map(schemaType).join(' | ');
  if (s.allOf) return s['x-ref-name'] || 'object';
  return (s.type || (s.properties ? 'object' : 'any')) + (s.format ? `<${s.format}>` : '');
}

function renderSchema(s: any, depth = 0): string {
  if (!s || depth > 5) return '';
  if (s.type === 'array') return renderSchema(s.items, depth);
  let props: Record<string, any> = s.properties || {};
  let required: string[] = s.required || [];
  if (s.allOf) {
    for (const part of s.allOf) {
      props = { ...props, ...(part.properties || {}) };
      required = [...required, ...(part.required || [])];
    }
  }
  const entries = Object.entries(props);
  if (!entries.length) return '';
  return `<ul class="schema">${entries
    .map(([name, p]) => {
      const nested = renderSchema(p, depth + 1);
      const enumVals = p.enum ? `<div class="schema-enum">Allowed: ${p.enum.map((e: any) => `<code>${esc(JSON.stringify(e))}</code>`).join(' ')}</div>` : '';
      const head = `<span class="schema-name">${esc(name)}</span><span class="schema-type">${esc(schemaType(p))}</span>${required.includes(name) ? '<span class="schema-req">required</span>' : ''}${p.deprecated ? '<span class="schema-dep">deprecated</span>' : ''}`;
      const desc = p.description ? `<div class="schema-desc">${md(p.description)}</div>` : '';
      return nested
        ? `<li><details><summary>${head}</summary>${desc}${enumVals}${nested}</details></li>`
        : `<li><div class="schema-row">${head}</div>${desc}${enumVals}</li>`;
    })
    .join('')}</ul>`;
}

function renderApiOperation(n: PMNode, ctx: RenderContext): string {
  const spec = ctx.specs.get(String(n.attrs?.specId));
  const method = String(n.attrs?.method || 'get').toLowerCase();
  const path = String(n.attrs?.path || '/');
  if (!spec) return `<div class="callout callout-warning"><div class="callout-body"><p>API operation <code>${esc(method.toUpperCase())} ${esc(path)}</code> is unavailable (spec removed).</p></div></div>`;
  const op = findOperation(spec, method, path);
  if (!op) return `<div class="callout callout-warning"><div class="callout-body"><p>Operation <code>${esc(method.toUpperCase())} ${esc(path)}</code> not found in spec.</p></div></div>`;
  const groups: Record<string, any[]> = {};
  for (const p of op.parameters) (groups[p.in] ||= []).push(p);
  const paramTables = Object.entries(groups)
    .map(
      ([where, params]) =>
        `<h4>${esc(where[0].toUpperCase() + where.slice(1))} parameters</h4><ul class="schema">${params
          .map(
            (p) =>
              `<li><div class="schema-row"><span class="schema-name">${esc(p.name)}</span><span class="schema-type">${esc(schemaType(p.schema))}</span>${p.required ? '<span class="schema-req">required</span>' : ''}</div>${p.description ? `<div class="schema-desc">${md(p.description)}</div>` : ''}</li>`,
          )
          .join('')}</ul>`,
    )
    .join('');
  const bodyContent = op.requestBody?.content || {};
  const bodyType = Object.keys(bodyContent)[0];
  const bodySchema = bodyType ? bodyContent[bodyType].schema : null;
  const bodyExample = bodyType ? bodyContent[bodyType].example ?? exampleFromSchema(bodySchema) : null;
  const body = bodyType
    ? `<h4>Request body <span class="muted">${esc(bodyType)}</span>${op.requestBody?.required ? ' <span class="schema-req">required</span>' : ''}</h4>${renderSchema(bodySchema) || `<p class="muted">${esc(schemaType(bodySchema))}</p>`}`
    : '';
  const responses = Object.entries<any>(op.responses || {})
    .map(([code, r]) => {
      const ct = Object.keys(r.content || {})[0];
      const schema = ct ? r.content[ct].schema : null;
      const example = ct ? r.content[ct].example ?? exampleFromSchema(schema) : null;
      const cls = code.startsWith('2') ? 'ok' : code.startsWith('4') || code.startsWith('5') ? 'err' : 'other';
      return `<details class="response"><summary><span class="status status-${cls}">${esc(code)}</span> ${esc(r.description || '')}</summary>${renderSchema(schema)}${
        example !== null && example !== undefined ? `<pre class="example"><code>${esc(JSON.stringify(example, null, 2))}</code></pre>` : ''
      }</details>`;
    })
    .join('');
  const securitySchemes = spec.components?.securitySchemes || {};
  const security = (op.security || []).flatMap((s: any) => Object.keys(s)).map((k: string) => ({ name: k, ...(securitySchemes[k] || {}) }));
  const data = {
    method,
    path,
    servers: (spec.servers || []).map((s: any) => s.url),
    parameters: op.parameters.map((p) => ({ name: p.name, in: p.in, required: !!p.required, example: p.example ?? p.schema?.example ?? p.schema?.default ?? '' })),
    bodyType: bodyType || null,
    bodyExample,
    security,
  };
  return `<section class="api-op" id="op-${esc(method)}-${esc(slugifyHeading(path))}">
  <div class="api-op-head"><span class="method method-${esc(method)}">${esc(method.toUpperCase())}</span><code class="api-path">${esc(path)}</code>${op.deprecated ? '<span class="schema-dep">deprecated</span>' : ''}</div>
  ${op.description ? `<div class="api-desc">${md(op.description)}</div>` : ''}
  <div class="api-grid">
    <div class="api-ref">${paramTables}${body}${responses ? `<h4>Responses</h4>${responses}` : ''}</div>
    <div class="api-try" data-playground>
      <script type="application/json" class="api-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
      <div class="try-head"><strong>Try it</strong><select class="try-server" aria-label="Server">${data.servers.map((s: string) => `<option>${esc(s)}</option>`).join('') || '<option value="">(no server)</option>'}</select></div>
      <div class="try-body"></div>
      <button type="button" class="try-send">Send request</button>
      <div class="try-curl"><div class="code-head"><span>cURL</span><button class="copy-btn" type="button">Copy</button></div><pre><code></code></pre></div>
      <div class="try-response" hidden><div class="try-status"></div><pre><code></code></pre></div>
    </div>
  </div>
</section>`;
}
