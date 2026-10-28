import type { PoolConnection } from 'mysql2/promise';
import { exec, insert, json, one, query, tx } from '../db.js';
import { type PMNode, emptyDoc, extractText, jsonToYUpdate } from './prosemirror.js';
import { bumpContentVersion } from '../site/data.js';
import { buildTree, type PageRow } from './tree.js';
import { scheduleReindex } from '../search/indexer.js';
import { emit } from '../events.js';
import { slugify, uuid, debounceByKey } from '../util.js';

type LiveHandler = (pageId: string, doc: PMNode) => boolean;
let liveContentHandler: LiveHandler = () => false;
/** Registered by the collaboration server so API-side content changes reach connected editors. */
export function setLiveContentHandler(fn: LiveHandler) {
  liveContentHandler = fn;
}

export async function getMainBranch(spaceId: string, conn?: PoolConnection) {
  return one('SELECT * FROM branches WHERE space_id=? AND is_main=1', [spaceId], conn);
}

export async function uniqueSlug(branchId: string, parentStableId: string | null, base: string, excludeStableId?: string): Promise<string> {
  const siblings = await query<{ slug: string }>(
    `SELECT slug FROM pages WHERE branch_id=? AND deleted=0 AND ${parentStableId ? 'parent_stable_id=?' : 'parent_stable_id IS NULL'} ${excludeStableId ? 'AND stable_id<>?' : ''}`,
    [branchId, ...(parentStableId ? [parentStableId] : []), ...(excludeStableId ? [excludeStableId] : [])],
  );
  const taken = new Set(siblings.map((s) => s.slug));
  let slug = slugify(base);
  let i = 2;
  const root = slug;
  while (taken.has(slug)) slug = `${root}-${i++}`;
  return slug;
}

export async function createPage(
  args: {
    spaceId: string;
    branchId: string;
    title: string;
    parentStableId?: string | null;
    kind?: string;
    content?: PMNode;
    position?: number;
    slug?: string;
    description?: string | null;
    icon?: string | null;
    linkUrl?: string | null;
    userId?: string | null;
  },
  conn?: PoolConnection,
) {
  const branch = await one('SELECT * FROM branches WHERE id=?', [args.branchId], conn);
  if (!branch) throw new Error('Branch not found');
  const parent = args.parentStableId ?? null;
  let position = args.position;
  if (position === undefined) {
    const last = await one<{ m: number | null }>(
      `SELECT MAX(position) AS m FROM pages WHERE branch_id=? AND ${parent ? 'parent_stable_id=?' : 'parent_stable_id IS NULL'}`,
      [args.branchId, ...(parent ? [parent] : [])],
      conn,
    );
    position = (last?.m ?? 0) + 1;
  }
  const doc = args.content ?? emptyDoc();
  const id = uuid();
  const stableId = uuid();
  await insert(
    'pages',
    {
      id,
      space_id: args.spaceId,
      branch_id: args.branchId,
      stable_id: stableId,
      parent_stable_id: parent,
      kind: args.kind || 'doc',
      title: args.title,
      slug: args.slug || (await uniqueSlug(args.branchId, parent, args.title)),
      description: args.description ?? null,
      icon: args.icon ?? null,
      link_url: args.linkUrl ?? null,
      position,
      content: doc,
      content_text: extractText(doc),
      ydoc: Buffer.from(jsonToYUpdate(doc)),
      version: 1,
      base_version: null,
      modified: branch.is_main ? 0 : 1,
      updated_by: args.userId ?? null,
    },
    conn,
  );
  if (branch.is_main && !conn) await afterMainChange(args.spaceId, stableId);
  return { id, stableId, branch };
}

const versionSnapshotThrottle = new Map<string, number>();

export async function snapshotVersion(page: any, userId: string | null, message: string | null = null, force = false) {
  const last = versionSnapshotThrottle.get(page.id) || 0;
  if (!force && Date.now() - last < 10 * 60_000) return;
  versionSnapshotThrottle.set(page.id, Date.now());
  await insert('page_versions', {
    id: uuid(),
    page_id: page.id,
    space_id: page.space_id,
    branch_id: page.branch_id,
    stable_id: page.stable_id,
    title: page.title,
    content: typeof page.content === 'string' ? page.content : JSON.stringify(page.content),
    content_text: page.content_text,
    version: page.version,
    message,
    created_by: userId,
  });
}

const pageUpdatedEvent = debounceByKey<string>(30_000, (key) => {
  const [orgId, spaceId, stableId, title] = key.split('|');
  void emit('page.updated', { orgId, spaceId }, { pageId: stableId, title });
});

export async function afterMainChange(spaceId: string, stableId: string | null) {
  await bumpContentVersion(spaceId);
  if (stableId) scheduleReindex(spaceId, stableId);
}

/**
 * Persist new content for a page. `fromCollab` means the change came from the live Yjs document
 * (which already holds it); otherwise the live document is updated or reset to match.
 */
export async function savePageContent(
  pageId: string,
  doc: PMNode,
  userId: string | null,
  opts: { fromCollab?: boolean; ydoc?: Uint8Array; message?: string; forceVersion?: boolean } = {},
) {
  const page = await one('SELECT p.*, b.is_main, s.org_id FROM pages p JOIN branches b ON b.id=p.branch_id JOIN spaces s ON s.id=p.space_id WHERE p.id=?', [pageId]);
  if (!page) return;
  const text = extractText(doc);
  const contentStr = JSON.stringify(doc);
  if (contentStr === (typeof page.content === 'string' ? page.content : JSON.stringify(page.content)) && !opts.message) {
    if (opts.ydoc) await exec('UPDATE pages SET ydoc=? WHERE id=?', [Buffer.from(opts.ydoc), pageId]);
    return;
  }
  // Snapshot the previous state before overwriting it.
  await snapshotVersion(page, userId, opts.message ?? null, !!opts.forceVersion);
  let ydoc: Buffer | null = opts.ydoc ? Buffer.from(opts.ydoc) : null;
  if (!opts.fromCollab) {
    const applied = liveContentHandler(pageId, doc);
    ydoc = applied ? null : Buffer.from(jsonToYUpdate(doc));
  }
  await exec(
    `UPDATE pages SET content=?, content_text=?, version=version+1, modified=IF(?, modified, 1), updated_by=?, updated_at=NOW(3)${ydoc ? ', ydoc=?' : ''} WHERE id=?`,
    [contentStr, text, page.is_main ? 1 : 0, userId, ...(ydoc ? [ydoc] : []), pageId],
  );
  if (page.is_main) {
    await afterMainChange(page.space_id, page.stable_id);
    pageUpdatedEvent(`${page.org_id}|${page.space_id}|${page.stable_id}|${page.title.replace(/\|/g, ' ')}`);
  }
}

/** Current main-branch URL path of every page, used to create automatic redirects after moves/renames. */
export async function snapshotPaths(spaceId: string): Promise<Map<string, string>> {
  const pages = await query<PageRow>(
    `SELECT p.stable_id, p.parent_stable_id, p.title, p.slug, p.kind, p.position, p.hidden, p.icon, p.link_url, p.description, p.id
     FROM pages p JOIN branches b ON b.id=p.branch_id WHERE b.space_id=? AND b.is_main=1 AND p.deleted=0`,
    [spaceId],
  );
  const { flat } = buildTree(pages);
  return new Map(flat.map((n) => [n.stable_id, n.path]));
}

export async function recordMovedPaths(spaceId: string, before: Map<string, string>) {
  const after = await snapshotPaths(spaceId);
  for (const [stableId, oldPath] of before) {
    const newPath = after.get(stableId);
    if (!newPath || newPath === oldPath) continue;
    await exec('DELETE FROM redirects WHERE space_id=? AND source=?', [spaceId, '/' + newPath]);
    const exists = await one('SELECT id FROM redirects WHERE space_id=? AND source=?', [spaceId, '/' + oldPath]);
    if (exists) await exec('UPDATE redirects SET target=? WHERE id=?', ['/' + newPath, exists.id]);
    else await insert('redirects', { id: uuid(), space_id: spaceId, source: '/' + oldPath, target: '/' + newPath, status_code: 301, automatic: 1 });
  }
}

export async function updatePageMeta(pageId: string, patch: Record<string, unknown>, userId: string | null) {
  const page = await one('SELECT p.*, b.is_main FROM pages p JOIN branches b ON b.id=p.branch_id WHERE p.id=?', [pageId]);
  if (!page) return null;
  const data: Record<string, unknown> = { ...patch, updated_by: userId, updated_at: new Date() };
  if (!page.is_main) data.modified = 1;
  data.version = page.version + 1;
  const keys = Object.keys(data);
  const movesPath = page.is_main && ('slug' in patch || 'parent_stable_id' in patch);
  const before = movesPath ? await snapshotPaths(page.space_id) : null;
  await exec(`UPDATE pages SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE id=?`, [...keys.map((k) => data[k] as any), pageId]);
  if (page.is_main) await afterMainChange(page.space_id, page.stable_id);
  if (before) await recordMovedPaths(page.space_id, before);
  return page;
}

/** Soft-delete a page subtree. On branches the rows stay as tombstones so merges can propagate deletes. */
export async function deletePageTree(branchId: string, stableId: string): Promise<string[]> {
  const all = await query<{ stable_id: string; parent_stable_id: string | null }>(
    'SELECT stable_id, parent_stable_id FROM pages WHERE branch_id=? AND deleted=0',
    [branchId],
  );
  const ids = [stableId];
  for (let i = 0; i < ids.length; i++) for (const p of all) if (p.parent_stable_id === ids[i]) ids.push(p.stable_id);
  const branch = await one('SELECT * FROM branches WHERE id=?', [branchId]);
  if (!ids.length || !branch) return [];
  if (branch.is_main) {
    await exec(`DELETE FROM pages WHERE branch_id=? AND stable_id IN (?)`, [branchId, ids]);
    await bumpContentVersion(branch.space_id);
    await exec('DELETE FROM page_chunks WHERE space_id=? AND page_stable_id IN (?)', [branch.space_id, ids]);
  } else {
    await exec(`UPDATE pages SET deleted=1, modified=1, updated_at=NOW(3) WHERE branch_id=? AND stable_id IN (?)`, [branchId, ids]);
  }
  return ids;
}

/** Fork a branch from main: copies every page and records the main version it was based on. */
export async function createBranch(spaceId: string, name: string, userId: string) {
  return tx(async (conn) => {
    const main = await getMainBranch(spaceId, conn);
    if (!main) throw new Error('Space has no main branch');
    const id = uuid();
    await insert('branches', { id, space_id: spaceId, name, is_main: 0, status: 'open', created_by: userId }, conn);
    await exec(
      `INSERT INTO pages (id, space_id, branch_id, stable_id, parent_stable_id, kind, title, slug, description, icon, position, hidden, link_url,
         content, content_text, ydoc, version, base_version, modified, deleted, updated_by, created_at, updated_at)
       SELECT UUID(), space_id, ?, stable_id, parent_stable_id, kind, title, slug, description, icon, position, hidden, link_url,
         content, content_text, ydoc, version, version, 0, 0, updated_by, created_at, updated_at
       FROM pages WHERE branch_id=? AND deleted=0`,
      [id, main.id],
      conn,
    );
    return id;
  });
}

export interface MergeConflict {
  stableId: string;
  title: string;
  reason: string;
}

export interface BranchChange {
  stableId: string;
  title: string;
  type: 'added' | 'modified' | 'deleted';
  conflict: boolean;
  branchPage: any;
  mainPage: any | null;
}

export async function branchChanges(branchId: string): Promise<BranchChange[]> {
  const branch = await one('SELECT * FROM branches WHERE id=?', [branchId]);
  if (!branch) return [];
  const main = await getMainBranch(branch.space_id);
  const changed = await query('SELECT * FROM pages WHERE branch_id=? AND modified=1', [branchId]);
  if (!changed.length) return [];
  const mains = await query('SELECT * FROM pages WHERE branch_id=? AND stable_id IN (?)', [main!.id, changed.map((c) => c.stable_id)]);
  const mainBy = new Map(mains.map((m) => [m.stable_id, m]));
  const result: BranchChange[] = [];
  for (const p of changed) {
    const m = mainBy.get(p.stable_id) || null;
    if (p.base_version === null) {
      if (p.deleted) continue; // created and deleted within the branch
      result.push({ stableId: p.stable_id, title: p.title, type: 'added', conflict: false, branchPage: p, mainPage: null });
    } else if (p.deleted) {
      result.push({ stableId: p.stable_id, title: p.title, type: 'deleted', conflict: !!m && m.version !== p.base_version, branchPage: p, mainPage: m });
    } else {
      result.push({ stableId: p.stable_id, title: p.title, type: 'modified', conflict: !m || m.version !== p.base_version, branchPage: p, mainPage: m });
    }
  }
  return result;
}

/** Merge a branch into main. Conflicts (main changed since fork) block unless `force` (branch wins). */
export async function mergeBranch(branchId: string, userId: string, force = false): Promise<{ merged: number; conflicts: MergeConflict[] }> {
  const changes = await branchChanges(branchId);
  const conflicts = changes
    .filter((c) => c.conflict)
    .map((c) => ({ stableId: c.stableId, title: c.title, reason: c.mainPage ? 'Changed on main since this branch was created' : 'Deleted on main' }));
  if (conflicts.length && !force) return { merged: 0, conflicts };
  const branch = await one('SELECT * FROM branches WHERE id=?', [branchId]);
  const main = await getMainBranch(branch!.space_id);
  const pathsBefore = await snapshotPaths(branch!.space_id);
  const touched: string[] = [];
  const contentUpdates: { pageId: string; doc: PMNode }[] = [];
  await tx(async (conn) => {
    for (const c of changes) {
      const p = c.branchPage;
      if (c.type === 'deleted') {
        if (c.mainPage) await exec('DELETE FROM pages WHERE id=?', [c.mainPage.id], conn);
        await exec('DELETE FROM page_chunks WHERE space_id=? AND page_stable_id=?', [branch!.space_id, p.stable_id], conn);
        continue;
      }
      const fields = {
        parent_stable_id: p.parent_stable_id,
        kind: p.kind,
        title: p.title,
        slug: p.slug,
        description: p.description,
        icon: p.icon,
        position: p.position,
        hidden: p.hidden,
        link_url: p.link_url,
        content: p.content,
        content_text: p.content_text,
        updated_by: userId,
      };
      if (c.mainPage) {
        const keys = Object.keys(fields);
        await exec(
          `UPDATE pages SET ${keys.map((k) => `\`${k}\`=?`).join(',')}, version=version+1, ydoc=NULL, updated_at=NOW(3) WHERE id=?`,
          [...keys.map((k) => (fields as any)[k]), c.mainPage.id],
          conn,
        );
        contentUpdates.push({ pageId: c.mainPage.id, doc: json<PMNode>(p.content, emptyDoc()) });
      } else {
        await insert('pages', { id: uuid(), space_id: branch!.space_id, branch_id: main!.id, stable_id: p.stable_id, ...fields, version: 1, modified: 0 }, conn);
      }
      touched.push(p.stable_id);
    }
    await exec(`UPDATE branches SET status='merged', merged_at=NOW(3) WHERE id=?`, [branchId], conn);
  });
  for (const u of contentUpdates) liveContentHandler(u.pageId, u.doc);
  await bumpContentVersion(branch!.space_id);
  await recordMovedPaths(branch!.space_id, pathsBefore);
  for (const s of touched) scheduleReindex(branch!.space_id, s);
  return { merged: changes.length, conflicts: [] };
}

/** Pull main-branch changes into an open branch for pages the branch has not modified. */
export async function updateBranchFromMain(branchId: string): Promise<number> {
  const branch = await one('SELECT * FROM branches WHERE id=?', [branchId]);
  if (!branch || branch.is_main) return 0;
  const main = await getMainBranch(branch.space_id);
  const mainPages = await query('SELECT * FROM pages WHERE branch_id=?', [main!.id]);
  const branchPages = await query('SELECT * FROM pages WHERE branch_id=?', [branchId]);
  const byStable = new Map(branchPages.map((p) => [p.stable_id, p]));
  let updated = 0;
  for (const m of mainPages) {
    const b = byStable.get(m.stable_id);
    if (!b) {
      await exec(
        `INSERT INTO pages (id, space_id, branch_id, stable_id, parent_stable_id, kind, title, slug, description, icon, position, hidden, link_url, content, content_text, ydoc, version, base_version, modified, deleted)
         SELECT UUID(), space_id, ?, stable_id, parent_stable_id, kind, title, slug, description, icon, position, hidden, link_url, content, content_text, ydoc, version, version, 0, 0 FROM pages WHERE id=?`,
        [branchId, m.id],
      );
      updated++;
    } else if (!b.modified && b.base_version !== m.version) {
      await exec(
        `UPDATE pages SET parent_stable_id=?, kind=?, title=?, slug=?, description=?, icon=?, position=?, hidden=?, link_url=?, content=?, content_text=?, ydoc=NULL, version=?, base_version=? WHERE id=?`,
        [m.parent_stable_id, m.kind, m.title, m.slug, m.description, m.icon, m.position, m.hidden, m.link_url, m.content, m.content_text, m.version, m.version, b.id],
      );
      liveContentHandler(b.id, json<PMNode>(m.content, emptyDoc()));
      updated++;
    } else if (b.modified && b.base_version !== null) {
      // Modified on both sides: keep branch content, but rebase so only true conflicts remain flagged.
    }
  }
  return updated;
}
