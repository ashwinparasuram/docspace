import express, { type Request, type Response, Router } from 'express';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { json, one, query } from '../db.js';
import { cache } from '../redis.js';
import { ah, escapeHtml as esc, hmac, safeEqual, sha256 } from '../util.js';
import { verifyPassword, resolveUser } from '../auth/session.js';
import { getSpaceRole, atLeast, type SpaceSettings } from '../permissions.js';
import { getSiteData, getMainPageContent, spaceSeo, spaceTheme, getSpaceCached, type SiteData } from './data.js';
import { prepareContext, renderBlocks } from './render.js';
import { renderLayout, simplePage, pageHref } from './layout.js';
import { collectHeadings, toMarkdown, type PMNode } from '../content/prosemirror.js';
import { readingOrder, type TreeNode } from '../content/tree.js';
import { track } from '../analytics.js';
import { aiEnabled } from '../ai/provider.js';

const require = createRequire(import.meta.url);

// ------------------------------------------------------------------------------------------
// Static site assets (bundled locally: no CDN)
// ------------------------------------------------------------------------------------------

function hljsCss(): string {
  try {
    const dir = join(require.resolve('highlight.js/package.json'), '..', 'styles');
    const light = readFileSync(join(dir, 'github.css'), 'utf8');
    const dark = readFileSync(join(dir, 'github-dark.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\})\s*([^{}@]+)\{/g, (_m, b: string, sel: string) => `${b}\n${sel.split(',').map((s) => `html.dark ${s.trim()}`).join(', ')}{`);
    return light + '\n' + dark;
  } catch {
    return '';
  }
}

export const siteAssets = Router();
const hljsStyles = hljsCss();
siteAssets.get('/_site/hljs.css', (_req, res) => {
  res.type('text/css').setHeader('Cache-Control', 'public, max-age=86400');
  res.send(hljsStyles);
});
siteAssets.get('/_site/mermaid.min.js', (_req, res) => {
  const file = join(require.resolve('mermaid/package.json'), '..', 'dist', 'mermaid.min.js');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(file);
});
siteAssets.get('/_site/inter.woff2', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('font/woff2').sendFile(join(require.resolve('@fontsource-variable/inter/package.json'), '..', 'files', 'inter-latin-wght-normal.woff2'));
});
siteAssets.use('/_site', express.static(config.siteAssetsDir, { maxAge: config.isProd ? '1h' : 0 }));

// ------------------------------------------------------------------------------------------
// Access control for published sites
// ------------------------------------------------------------------------------------------

const siteCookie = (spaceId: string) => `ds_site_${spaceId.slice(0, 8)}`;
const VISITOR_COOKIE = 'ds_view_as_visitor';
/**
 * Reader unlock token. It is bound to the current visibility mode, password and share token, so
 * changing any of them (e.g. password -> members only) invalidates every previously issued cookie.
 */
const siteToken = (space: any) =>
  hmac(config.secret, `site:${space.id}:${space.visibility}:${space.site_password_hash || ''}:${space.share_token || ''}`);

/** `member`: access was granted only because the reader is signed in with access to the space. */
type Access = { ok: true; preview: boolean; member: boolean } | { ok: false; reason: 'password' | 'login' | 'notfound' };

async function checkAccess(req: Request, res: Response, space: any): Promise<Access> {
  // Members can preview what anonymous visitors get (?as=visitor), and switch back with ?as=member.
  let asVisitor = req.cookies?.[VISITOR_COOKIE] === '1';
  if (req.query.as === 'visitor' || req.query.as === 'member') {
    asVisitor = req.query.as === 'visitor';
    if (asVisitor) res.cookie(VISITOR_COOKIE, '1', { httpOnly: true, sameSite: 'lax', path: '/' });
    else res.clearCookie(VISITOR_COOKIE, { path: '/' });
  }
  const restricted = space.visibility === 'password' || space.visibility === 'share' || space.visibility === 'members';
  const share = typeof req.query.share === 'string' ? req.query.share : null;
  if (space.published && restricted && share && space.share_token && safeEqual(share, space.share_token)) {
    res.cookie(siteCookie(space.id), siteToken(space), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400_000, path: '/' });
    return { ok: true, preview: false, member: false };
  }
  const cookieOk = !!req.cookies?.[siteCookie(space.id)] && safeEqual(req.cookies[siteCookie(space.id)], siteToken(space));
  const isMember = async () => {
    if (asVisitor) return false;
    if (!req.user) await resolveUser(req);
    if (!req.user || req.mfaPending) return false;
    return atLeast(await getSpaceRole(req.user.id, req.user.is_admin, space), 'reader');
  };
  if (!space.published) {
    // Unpublished: only space members can preview.
    return (await isMember()) ? { ok: true, preview: true, member: true } : { ok: false, reason: 'notfound' };
  }
  switch (space.visibility) {
    case 'public':
    case 'unlisted':
      return { ok: true, preview: false, member: false };
    case 'password':
      if (cookieOk) return { ok: true, preview: false, member: false };
      if (await isMember()) return { ok: true, preview: false, member: true };
      return { ok: false, reason: 'password' };
    case 'share':
      if (cookieOk) return { ok: true, preview: false, member: false };
      if (await isMember()) return { ok: true, preview: false, member: true };
      return { ok: false, reason: 'notfound' };
    default:
      // members only: a valid share link also works (it is shown in the publishing settings)
      if (cookieOk) return { ok: true, preview: false, member: false };
      return (await isMember()) ? { ok: true, preview: false, member: true } : { ok: false, reason: 'login' };
  }
}

/** Banner shown to signed-in members on restricted sites, so it is clear why they can see it. */
function memberNotice(space: any, req: Request): string {
  const what: Record<string, string> = {
    password: 'Visitors are asked for the site password.',
    share: 'Visitors need the secret share link.',
    members: 'Visitors without access are asked to sign in.',
  };
  const reason = !space.published ? 'This site is not published. Only members can preview it.' : what[space.visibility] || '';
  const url = new URL(req.originalUrl, 'http://x');
  url.searchParams.set('as', 'visitor');
  return `<div class="member-notice"><span><strong>You can see this page because you are signed in with access to this space.</strong> ${esc(reason)}</span><a href="${esc(url.pathname + url.search)}">View as visitor</a></div>`;
}

function visitorNotice(req: Request): string {
  if (req.cookies?.[VISITOR_COOKIE] !== '1' && req.query.as !== 'visitor') return '';
  if (req.query.as === 'member') return '';
  const url = new URL(req.originalUrl, 'http://x');
  url.searchParams.set('as', 'member');
  return `<div class="member-notice"><span><strong>Viewing as a visitor.</strong> Your sign-in is ignored on published sites.</span><a href="${esc(url.pathname + url.search)}">Stop viewing as visitor</a></div>`;
}

/** Express middleware for the public API: resolves the site and enforces the same access rules. */
export async function requireSiteAccess(req: Request, res: Response, spaceId: string) {
  const space = await getSpaceCached(spaceId);
  if (!space) return null;
  const access = await checkAccess(req, res, space);
  return access.ok ? space : null;
}

// ------------------------------------------------------------------------------------------
// Site resolution: custom domains and /s/:org/:space paths
// ------------------------------------------------------------------------------------------

async function spaceByDomain(host: string) {
  const key = `domain:${host}`;
  const cached = await cache.get(key);
  if (cached) return cached === '-' ? null : getSpaceCached(cached);
  const row = await one('SELECT id FROM spaces WHERE custom_domain=? AND domain_verified=1', [host]);
  await cache.set(key, row ? row.id : '-', 60);
  return row ? getSpaceCached(row.id) : null;
}

async function spaceBySlug(orgSlug: string, spaceSlug: string) {
  const key = `slug:${orgSlug}/${spaceSlug}`;
  const cached = await cache.get(key);
  if (cached) return cached === '-' ? null : getSpaceCached(cached);
  const row = await one('SELECT s.id FROM spaces s JOIN organizations o ON o.id=s.org_id WHERE o.slug=? AND s.slug=?', [orgSlug, spaceSlug]);
  await cache.set(key, row ? row.id : '-', 30);
  return row ? getSpaceCached(row.id) : null;
}

/** Public URL of a space's site: its verified custom domain (same scheme/port as the app) or the /s/ path. */
export function siteUrl(space: { slug: string; custom_domain?: string | null; domain_verified?: unknown }, orgSlug: string) {
  if (!space.custom_domain || !space.domain_verified) return `${config.appUrl}/s/${orgSlug}/${space.slug}`;
  const app = new URL(config.appUrl);
  return `${app.protocol}//${space.custom_domain}${app.port ? `:${app.port}` : ''}`;
}

export function siteBase(space: any, org: { slug: string }, viaDomain: boolean) {
  return viaDomain ? '' : `/s/${org.slug}/${space.slug}`;
}

export const siteRouter = Router();

/** Custom-domain requests: any host other than the app host that maps to a verified space domain. */
export const customDomainHandler = ah(async (req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase().split(':')[0];
  const appHost = config.appHost.split(':')[0];
  if (!host || host === appHost || host === 'localhost' || host === '127.0.0.1') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/_site/') || req.path.startsWith('/files/')) return next();
  const space = await spaceByDomain(host);
  if (!space) return next();
  await serveSite(req, res, space, '', decodeURIComponent(req.path.replace(/^\/+/, '')), true);
});

siteRouter.all(
  /^\/s\/([^/]+)\/([^/]+)(?:\/(.*))?$/,
  ah(async (req, res) => {
    const params = req.params as unknown as Record<string, string>;
    const space = await spaceBySlug(params[0], params[1]);
    if (!space) return void res.status(404).send(simplePage('Not found', '<h1>404</h1><p>This site does not exist.</p>'));
    await serveSite(req, res, space, `/s/${params[0]}/${params[1]}`, decodeURIComponent(params[2] || ''), false);
  }),
);

// ------------------------------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------------------------------

function siteFeatures(space: any) {
  const s = json<SpaceSettings>(space.settings, {});
  return {
    search: s.searchEnabled !== false,
    ai: s.aiEnabled !== false,
    feedback: s.feedbackEnabled !== false,
    aiLlm: aiEnabled(),
    llmsTxt: s.llmsTxt !== false,
  };
}

function absoluteBase(req: Request, base: string, viaDomain: boolean) {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  return viaDomain ? `${proto}://${req.headers.host}` : `${config.appUrl}${base}`;
}

async function serveSite(req: Request, res: Response, space: any, base: string, rest: string, viaDomain: boolean) {
  const org = await one('SELECT name, slug FROM organizations WHERE id=?', [space.org_id]);
  const theme = spaceTheme(space);

  if (req.method === 'POST' && rest === '_auth') return passwordLogin(req, res, space, base);
  if (req.method !== 'GET' && req.method !== 'HEAD') return void res.status(405).end();

  const access = await checkAccess(req, res, space);
  // HTML is never reused without asking the server: access rules can change at any time.
  res.setHeader('Cache-Control', 'private, no-store');
  const notice = access.ok ? (access.member ? memberNotice(space, req) : visitorNotice(req)) : visitorNotice(req);
  if (!access.ok) {
    if (access.reason === 'password') {
      return void res.status(401).send(
        simplePage(
          space.name,
          `<h1>${esc(space.name)}</h1><p>This documentation is password protected.</p><form method="post" action="${esc(base)}/_auth"><input type="hidden" name="next" value="${esc(req.originalUrl)}"><input type="password" name="password" placeholder="Password" required autofocus><button type="submit">Continue</button></form>${req.query.error ? '<p class="error">Incorrect password</p>' : ''}`,
          theme.primaryColor,
          notice,
        ),
      );
    }
    if (access.reason === 'login') {
      const next = encodeURIComponent(req.originalUrl);
      return void res.status(401).send(
        simplePage(space.name, `<h1>${esc(space.name)}</h1><p>This documentation is only available to members.</p><p><a class="btn" href="${esc(config.appUrl)}/login?next=${next}">Sign in</a></p>`, theme.primaryColor, notice),
      );
    }
    return void res.status(404).send(simplePage('Not found', '<h1>404</h1><p>This site does not exist.</p>', undefined, notice));
  }

  const features = siteFeatures(space);
  const seo = spaceSeo(space);
  const noindex = space.visibility !== 'public' || !!seo.noindex || access.preview || access.member;
  const site = await getSiteData(space);
  const absBase = absoluteBase(req, base, viaDomain);

  if (rest === 'robots.txt') {
    res.type('text/plain');
    return void res.send(noindex ? 'User-agent: *\nDisallow: /\n' : `User-agent: *\nAllow: /\n\nSitemap: ${absBase}/sitemap.xml\n`);
  }
  if (rest === 'sitemap.xml') {
    if (noindex) return void res.status(404).end();
    const urls = site.flat
      .filter((p) => !p.hidden && (p.kind === 'doc' || p.kind === 'api'))
      .map((p) => `<url><loc>${esc(`${absBase}/${p.path}`)}</loc>${p.updated_at ? `<lastmod>${new Date(p.updated_at).toISOString()}</lastmod>` : ''}</url>`);
    res.type('application/xml');
    return void res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
  }
  if ((rest === 'llms.txt' || rest === 'llms-full.txt') && features.llmsTxt) {
    track(req, { spaceId: space.id, type: 'markdown', path: '/' + rest });
    res.type('text/plain; charset=utf-8');
    return void res.send(await llmsTxt(space, site, absBase, rest === 'llms-full.txt'));
  }

  const isMarkdown = rest.endsWith('.md');
  const path = (isMarkdown ? rest.slice(0, -3) : rest).replace(/\/+$/, '');
  const readable = readingOrder(site.flat);
  let page: TreeNode | null | undefined = path ? site.byPath.get(path) : readable[0];
  if (page && page.kind === 'group') page = readable.find((p) => p.path.startsWith(page!.path + '/')) || null;
  if (page && page.kind === 'link') return void res.redirect(302, page.link_url || '/');

  if (!page) {
    const redirect = await findRedirect(space.id, '/' + path);
    if (redirect) {
      const target = /^https?:/.test(redirect.target) ? redirect.target : `${base}${redirect.target}`;
      return void res.redirect(redirect.status_code === 302 ? 302 : 301, target);
    }
    res.status(404);
    if (!path && !readable.length) {
      return void res.send(renderLayout({ ...layoutBase(space, org, theme, seo, base, absBase, site, features, noindex, notice), page: null, title: space.name, description: '', contentHtml: '<div class="empty"><h1>Nothing here yet</h1><p>This site has no published pages.</p></div>', headings: [], prev: null, next: null, updatedAt: null, breadcrumbs: [] }));
    }
    return void res.send(renderLayout({ ...layoutBase(space, org, theme, seo, base, absBase, site, features, true, notice), page: null, title: 'Page not found', description: '', contentHtml: `<div class="empty"><h1>Page not found</h1><p>The page you are looking for doesn't exist or has moved.</p><p><a class="btn" href="${esc(base || '/')}">Go to home</a></p></div>`, headings: [], prev: null, next: null, updatedAt: null, breadcrumbs: [] }));
  }

  if (isMarkdown) {
    track(req, { spaceId: space.id, type: 'markdown', pageStableId: page.stable_id, path: '/' + page.path + '.md' });
    const md = await pageMarkdown(space, site, page, absBase);
    res.type('text/markdown; charset=utf-8');
    return void res.send(md);
  }

  // AI agents get Markdown when they ask for it (content negotiation).
  const accept = String(req.headers.accept || '');
  if (accept.includes('text/markdown') && !accept.includes('text/html')) {
    track(req, { spaceId: space.id, type: 'markdown', pageStableId: page.stable_id, path: '/' + page.path });
    res.type('text/markdown; charset=utf-8');
    return void res.send(await pageMarkdown(space, site, page, absBase));
  }

  track(req, { spaceId: space.id, type: 'pageview', pageStableId: page.stable_id, path: '/' + page.path });

  const cacheKey = `html:${space.id}:${space.content_version}:${viaDomain ? req.headers.host : base}:${page.path}:${noindex ? 1 : 0}:${notice ? sha256(notice).slice(0, 8) : 0}`;
  const etag = `W/"${sha256(cacheKey).slice(0, 20)}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Vary', 'Accept, Cookie');
  // Public pages may be cached by proxies but must be revalidated (cheap 304s) so visibility changes apply at once.
  res.setHeader('Cache-Control', space.visibility === 'public' && space.published && !notice ? 'public, no-cache' : 'private, no-cache');
  if (req.headers['if-none-match'] === etag) return void res.status(304).end();
  const cached = await cache.get(cacheKey);
  if (cached) return void res.type('html').send(cached);

  const content = await getMainPageContent(space.id, page.stable_id);
  const doc: PMNode = content?.content || { type: 'doc', content: [] };
  const ctx = await prepareContext([doc], space.id, (sid) => {
    const target = site.byStable.get(sid);
    return target ? pageHref(base, target.path) : null;
  });
  const contentHtml = renderBlocks(doc.content, ctx);
  const idx = readable.findIndex((p) => p.stable_id === page!.stable_id);
  const breadcrumbs: TreeNode[] = [];
  let cur = page.parent_stable_id ? site.byStable.get(page.parent_stable_id) : undefined;
  while (cur) {
    breadcrumbs.unshift(cur);
    cur = cur.parent_stable_id ? site.byStable.get(cur.parent_stable_id) : undefined;
  }
  const html = renderLayout({
    ...layoutBase(space, org, theme, seo, base, absBase, site, features, noindex, notice),
    page,
    title: page.title,
    description: page.description || seo.description || '',
    contentHtml,
    headings: collectHeadings(doc),
    prev: idx > 0 ? readable[idx - 1] : null,
    next: idx >= 0 && idx < readable.length - 1 ? readable[idx + 1] : null,
    updatedAt: content?.updated_at ? new Date(content.updated_at) : null,
    breadcrumbs,
  });
  await cache.set(cacheKey, html, 600);
  res.type('html').send(html);
}

function layoutBase(space: any, org: any, theme: any, seo: any, base: string, absBase: string, site: SiteData, features: ReturnType<typeof siteFeatures>, noindex: boolean, notice = '') {
  return { space, orgName: org?.name || '', theme, seo, base, canonicalBase: absBase, roots: site.roots, features, noindex, notice };
}

async function findRedirect(spaceId: string, path: string) {
  const rows = await query<{ source: string; target: string; status_code: number }>('SELECT source, target, status_code FROM redirects WHERE space_id=?', [spaceId]);
  const normalized = path.replace(/\/+$/, '') || '/';
  for (const r of rows) {
    const src = r.source.replace(/\/+$/, '') || '/';
    if (src === normalized) return r;
    if (src.endsWith('/*') && normalized.startsWith(src.slice(0, -1))) {
      return { ...r, target: r.target.endsWith('/*') ? r.target.slice(0, -1) + normalized.slice(src.length - 1) : r.target };
    }
  }
  return null;
}

async function passwordLogin(req: Request, res: Response, space: any, base: string) {
  const password = String(req.body?.password || '');
  const nextUrl = String(req.body?.next || base || '/');
  const safeNext = nextUrl.startsWith('/') && !nextUrl.startsWith('//') ? nextUrl : base || '/';
  if (space.visibility === 'password' && (await verifyPassword(password, space.site_password_hash))) {
    res.cookie(siteCookie(space.id), siteToken(space), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400_000, path: '/' });
    return void res.redirect(303, safeNext);
  }
  res.redirect(303, `${safeNext}${safeNext.includes('?') ? '&' : '?'}error=1`);
}

async function pageMarkdown(space: any, site: SiteData, page: TreeNode, absBase: string): Promise<string> {
  const content = await getMainPageContent(space.id, page.stable_id);
  const doc = content?.content || { type: 'doc', content: [] };
  const ctx = await prepareContext([doc], space.id, () => null);
  const md = toMarkdown(doc, {
    resolvePageLink: (sid) => {
      const t = site.byStable.get(sid);
      return t ? `${absBase}/${t.path}.md` : null;
    },
    resolveReusable: (id) => ctx.reusable.get(id) || null,
  });
  return `# ${page.title}\n\n${page.description ? `> ${page.description}\n\n` : ''}${md}`;
}

async function llmsTxt(space: any, site: SiteData, absBase: string, full: boolean): Promise<string> {
  const pages = readingOrder(site.flat);
  if (!full) {
    const lines = [`# ${space.name}`, '', space.description ? `> ${space.description}\n` : ''];
    const sections = new Map<string, TreeNode[]>();
    for (const p of pages) {
      let top: TreeNode = p;
      while (top.parent_stable_id && site.byStable.get(top.parent_stable_id)) top = site.byStable.get(top.parent_stable_id)!;
      const key = top.kind === 'group' ? top.title : 'Docs';
      if (!sections.has(key)) sections.set(key, []);
      sections.get(key)!.push(p);
    }
    for (const [title, list] of sections) {
      lines.push(`## ${title}`, '');
      for (const p of list) lines.push(`- [${p.title}](${absBase}/${p.path}.md)${p.description ? `: ${p.description}` : ''}`);
      lines.push('');
    }
    return lines.join('\n');
  }
  const parts: string[] = [`# ${space.name}\n`];
  for (const p of pages.slice(0, 500)) parts.push(await pageMarkdown(space, site, p, absBase));
  return parts.join('\n\n---\n\n');
}

export function invalidateSiteLookups(space: { id: string; custom_domain?: string | null; slug: string }, orgSlug: string) {
  return Promise.all([
    cache.del(`space:${space.id}`, `slug:${orgSlug}/${space.slug}`),
    space.custom_domain ? cache.del(`domain:${space.custom_domain}`) : Promise.resolve(),
  ]);
}

export function existsWebDist() {
  return existsSync(join(config.webDist, 'index.html'));
}

