import type { TreeNode } from '../content/tree.js';
import type { Heading } from '../content/prosemirror.js';
import { escapeHtml as esc } from '../util.js';

export interface LayoutInput {
  space: any;
  orgName: string;
  theme: Record<string, any>;
  seo: Record<string, any>;
  base: string; // URL prefix of the site, '' for custom domains
  canonicalBase: string;
  roots: TreeNode[];
  page: TreeNode | null;
  title: string;
  description: string;
  contentHtml: string;
  headings: Heading[];
  prev: TreeNode | null;
  next: TreeNode | null;
  updatedAt: Date | null;
  breadcrumbs: TreeNode[];
  features: { search: boolean; ai: boolean; feedback: boolean; aiLlm: boolean };
  noindex: boolean;
  status?: number;
  /** Trusted HTML banner shown under the header (member preview notices). */
  notice?: string;
}

const FONT_STACKS: Record<string, string> = {
  Inter: `"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
  Serif: `ui-serif, Georgia, Cambria, "Times New Roman", Times, serif`,
  Mono: `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`,
  Rounded: `ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif`,
};

export function pageHref(base: string, path: string): string {
  return `${base}/${path}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function isActiveBranch(node: TreeNode, page: TreeNode | null): boolean {
  if (!page) return false;
  if (node.stable_id === page.stable_id) return true;
  return node.children.some((c) => isActiveBranch(c, page));
}

function navItems(nodes: TreeNode[], input: LayoutInput): string {
  return nodes
    .filter((n) => !n.hidden)
    .map((n) => {
      const visibleChildren = n.children.filter((c) => !c.hidden);
      if (n.kind === 'group') {
        return `<li class="nav-group"><div class="nav-group-title">${esc(n.title)}</div><ul>${navItems(visibleChildren, input)}</ul></li>`;
      }
      const icon = n.icon ? `<span class="nav-icon">${esc(n.icon)}</span>` : '';
      if (n.kind === 'link') {
        return `<li><a class="nav-link" href="${esc(n.link_url || '#')}" target="_blank" rel="noopener">${icon}${esc(n.title)}<span class="ext">↗</span></a></li>`;
      }
      const active = input.page?.stable_id === n.stable_id;
      const open = isActiveBranch(n, input.page);
      const href = pageHref(input.base, n.path);
      if (!visibleChildren.length) {
        return `<li><a class="nav-link${active ? ' active' : ''}" href="${esc(href)}"${active ? ' aria-current="page"' : ''}>${icon}${esc(n.title)}</a></li>`;
      }
      return `<li class="nav-parent${open ? ' open' : ''}"><div class="nav-row"><a class="nav-link${active ? ' active' : ''}" href="${esc(href)}"${active ? ' aria-current="page"' : ''}>${icon}${esc(n.title)}</a><button class="nav-toggle" type="button" aria-label="Toggle section" aria-expanded="${open}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/></svg></button></div><ul>${navItems(visibleChildren, input)}</ul></li>`;
    })
    .join('');
}

export function renderLayout(input: LayoutInput): string {
  const { space, theme, seo } = input;
  const primary = /^#[0-9a-f]{3,8}$/i.test(theme.primaryColor) ? theme.primaryColor : '#2563eb';
  const font = FONT_STACKS[theme.font] || FONT_STACKS.Inter;
  const fullTitle = input.page ? String(seo.titleTemplate || '%s').replace('%s', input.title) : `${space.name}`;
  const canonical = `${input.canonicalBase}${input.page ? '/' + input.page.path : ''}`;
  const toc = input.headings.filter((h) => h.level >= 2 && h.level <= 3);
  const logo = theme.logoUrl
    ? `<img src="${esc(theme.logoUrl)}" alt="${esc(space.name)}" class="logo-img">`
    : `<span class="logo-mark">${esc(space.icon || space.name.slice(0, 1).toUpperCase())}</span>`;
  const headerLinks = (theme.headerLinks || [])
    .filter((l: any) => l?.label && l?.url)
    .map((l: any) => `<a href="${esc(l.url)}" class="header-link">${esc(l.label)}</a>`)
    .join('');
  const jsonLd = input.page
    ? {
        '@context': 'https://schema.org',
        '@type': 'TechArticle',
        headline: input.title,
        description: input.description,
        dateModified: input.updatedAt?.toISOString(),
        url: canonical,
      }
    : { '@context': 'https://schema.org', '@type': 'WebSite', name: space.name, url: canonical };
  const siteConfig = {
    spaceId: space.id,
    base: input.base,
    pageId: input.page?.stable_id || null,
    features: input.features,
    mode: theme.mode || 'auto',
  };

  return `<!doctype html>
<html lang="${esc(seo.language || 'en')}" data-mode="${esc(theme.mode || 'auto')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(input.description)}">
<link rel="canonical" href="${esc(canonical)}">
${input.noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(input.title)}">
<meta property="og:description" content="${esc(input.description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:site_name" content="${esc(space.name)}">
${seo.ogImage ? `<meta property="og:image" content="${esc(seo.ogImage)}"><meta name="twitter:image" content="${esc(seo.ogImage)}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="generator" content="DocSpace">
${theme.faviconUrl ? `<link rel="icon" href="${esc(theme.faviconUrl)}">` : `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='${primary}'/><text x='16' y='22' font-size='17' font-weight='600' text-anchor='middle' fill='white' font-family='sans-serif'>${esc((space.name || 'D')[0])}</text></svg>`)}">`}
<link rel="alternate" type="text/markdown" href="${esc(input.page ? pageHref(input.base, input.page.path) + '.md' : input.base + '/llms.txt')}">
<link rel="stylesheet" href="/_site/site.css">
<link rel="stylesheet" href="/_site/hljs.css">
<style>:root{--primary:${primary};--font:${font}}${theme.customCss ? String(theme.customCss).replace(/<\/style/gi, '') : ''}</style>
<script>(function(){try{var m=localStorage.getItem('ds-mode')||${JSON.stringify(theme.mode || 'auto')};var d=m==='dark'||(m==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})()</script>
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="topbar">
  <button class="menu-btn" type="button" aria-label="Open navigation"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg></button>
  <a href="${esc(input.base || '/')}" class="brand">${logo}<span class="brand-name">${esc(space.name)}</span></a>
  <div class="topbar-spacer"></div>
  ${input.features.search ? `<button class="search-btn" type="button" aria-label="Search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><span>Search${input.features.ai ? ' or ask a question' : ''}</span><kbd>Ctrl K</kbd></button>` : ''}
  <nav class="header-links">${headerLinks}</nav>
  <button class="mode-btn" type="button" aria-label="Toggle dark mode"><svg class="sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><svg class="moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg></button>
</header>
${input.notice || ''}
<div class="shell">
  <aside class="sidebar" aria-label="Documentation navigation">
    <nav><ul class="nav-root">${navItems(input.roots, input)}</ul></nav>
    <div class="sidebar-foot">Published with DocSpace</div>
  </aside>
  <div class="sidebar-backdrop"></div>
  <main id="content" class="main">
    <article class="article">
      ${
        input.breadcrumbs.length
          ? `<nav class="breadcrumbs" aria-label="Breadcrumb">${input.breadcrumbs
              .map((b) => (b.kind === 'group' ? `<span>${esc(b.title)}</span>` : `<a href="${esc(pageHref(input.base, b.path))}">${esc(b.title)}</a>`))
              .join('<span class="sep">/</span>')}</nav>`
          : ''
      }
      ${input.page ? `<header class="page-head"><h1>${input.page.icon ? `<span class="page-icon">${esc(input.page.icon)}</span>` : ''}${esc(input.title)}</h1>${input.description ? `<p class="lead">${esc(input.description)}</p>` : ''}</header>` : ''}
      <div class="prose">${input.contentHtml}</div>
      ${
        input.page && input.features.feedback
          ? `<div class="feedback" data-feedback><span>Was this page helpful?</span><button type="button" data-rating="1"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11"/><path d="M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.5l-2.3 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z"/></svg>Yes</button><button type="button" data-rating="-1"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V3"/><path d="M9 18.1 10 14H4.2a2 2 0 0 1-1.9-2.5l2.3-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.8a2 2 0 0 0-1.8 1.1L12 22a3.1 3.1 0 0 1-3-3.9Z"/></svg>No</button><form class="feedback-form" hidden><textarea placeholder="How can we improve this page? (optional)" maxlength="2000"></textarea><button type="submit">Send feedback</button></form><span class="feedback-thanks" hidden>Thanks for your feedback!</span></div>`
          : ''
      }
      ${
        input.prev || input.next
          ? `<nav class="pager">${input.prev ? `<a class="pager-prev" href="${esc(pageHref(input.base, input.prev.path))}"><small>Previous</small><span>${esc(input.prev.title)}</span></a>` : '<span></span>'}${input.next ? `<a class="pager-next" href="${esc(pageHref(input.base, input.next.path))}"><small>Next</small><span>${esc(input.next.title)}</span></a>` : ''}</nav>`
          : ''
      }
      <footer class="page-foot">
        ${input.updatedAt && theme.showEditedAt !== false ? `<span>Last updated <time datetime="${input.updatedAt.toISOString()}">${input.updatedAt.toISOString().slice(0, 10)}</time></span>` : ''}
        ${theme.footerText ? `<span>${esc(theme.footerText)}</span>` : ''}
      </footer>
    </article>
    ${
      toc.length > 1
        ? `<aside class="toc" aria-label="On this page"><div class="toc-title">On this page</div><ul>${toc
            .map((h) => `<li class="toc-l${h.level}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
            .join('')}</ul></aside>`
        : '<aside class="toc"></aside>'
    }
  </main>
</div>
${
  input.features.search
    ? `<div class="modal" id="search-modal" hidden role="dialog" aria-modal="true" aria-label="Search">
  <div class="modal-panel">
    <div class="search-input-row"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><input type="search" placeholder="Search docs${input.features.ai ? ' or ask a question' : ''}…" autocomplete="off" aria-label="Search query"><kbd>Esc</kbd></div>
    ${input.features.ai ? '<button type="button" class="ask-ai" hidden><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg><span class="ask-label"></span></button>' : ''}
    <div class="search-results" role="listbox"></div>
    <div class="ai-answer" hidden></div>
  </div>
</div>`
    : ''
}
<script id="ds-config" type="application/json">${JSON.stringify(siteConfig).replace(/</g, '\\u003c')}</script>
<script src="/_site/site.js" defer></script>
</body>
</html>`;
}

export function simplePage(title: string, body: string, primary = '#2563eb', notice = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/_site/site.css"><style>:root{--primary:${esc(primary)};--font:ui-sans-serif,system-ui,sans-serif}</style><script>try{var m=localStorage.getItem('ds-mode')||'auto';document.documentElement.classList.toggle('dark',m==='dark'||(m==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches))}catch(e){}</script></head><body>${notice}<div class="center-card">${body}</div></body></html>`;
}
