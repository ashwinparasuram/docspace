import { exec, json, one, query } from '../db.js';
import { buildTree, type PageRow, type TreeNode } from '../content/tree.js';
import { cache } from '../redis.js';
import type { PMNode } from '../content/prosemirror.js';

export interface SiteData {
  spaceId: string;
  version: number;
  roots: TreeNode[];
  byStable: Map<string, TreeNode>;
  byPath: Map<string, TreeNode>;
  flat: TreeNode[];
}

const local = new Map<string, SiteData>();

/** Main-branch page tree for a space, memoised per content_version (invalidated on every change). */
export async function getSiteData(space: { id: string; content_version: number }): Promise<SiteData> {
  const key = `${space.id}:${space.content_version}`;
  const hit = local.get(key);
  if (hit) return hit;
  const pages = await query<PageRow>(
    `SELECT p.id, p.stable_id, p.parent_stable_id, p.title, p.slug, p.kind, p.position, p.hidden, p.icon, p.link_url,
            p.description, p.updated_at
     FROM pages p JOIN branches b ON b.id=p.branch_id WHERE b.space_id=? AND b.is_main=1 AND p.deleted=0`,
    [space.id],
  );
  const tree = buildTree(pages);
  const data: SiteData = { spaceId: space.id, version: space.content_version, ...tree };
  for (const k of local.keys()) if (k.startsWith(space.id + ':')) local.delete(k);
  if (local.size > 500) local.delete(local.keys().next().value as string);
  local.set(key, data);
  return data;
}

export async function getMainPageContent(spaceId: string, stableId: string): Promise<{ content: PMNode; updated_at: Date; title: string } | null> {
  const row = await one(
    `SELECT p.content, p.updated_at, p.title FROM pages p JOIN branches b ON b.id=p.branch_id
     WHERE b.space_id=? AND b.is_main=1 AND p.stable_id=? AND p.deleted=0`,
    [spaceId, stableId],
  );
  if (!row) return null;
  return { content: json<PMNode>(row.content, { type: 'doc', content: [] }), updated_at: row.updated_at, title: row.title };
}

/** Bump the published content version: invalidates rendered-page caches everywhere (Redis keys are versioned). */
export async function bumpContentVersion(spaceId: string): Promise<void> {
  await exec('UPDATE spaces SET content_version=content_version+1, updated_at=NOW(3) WHERE id=?', [spaceId]);
  await cache.del(`space:${spaceId}`);
}

export async function getSpaceCached(spaceId: string): Promise<any | null> {
  const raw = await cache.get(`space:${spaceId}`);
  if (raw) return JSON.parse(raw);
  const s = await one('SELECT * FROM spaces WHERE id=?', [spaceId]);
  if (s) await cache.set(`space:${spaceId}`, JSON.stringify(s), 30);
  return s;
}

export function spaceTheme(space: any) {
  return {
    primaryColor: '#2563eb',
    mode: 'auto',
    logoUrl: '',
    faviconUrl: '',
    font: 'Inter',
    headerLinks: [] as { label: string; url: string }[],
    footerText: '',
    showEditedAt: true,
    customCss: '',
    ...json<Record<string, any>>(space.theme, {}),
  };
}

export function spaceSeo(space: any) {
  return {
    titleTemplate: '%s | ' + space.name,
    description: space.description || '',
    ogImage: '',
    noindex: false,
    ...json<Record<string, any>>(space.seo, {}),
  };
}
