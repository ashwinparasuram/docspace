import { Router } from 'express';
import { z } from 'zod';
import { diffLines } from 'diff';
import { exec, json, one, query } from '../db.js';
import { requireAuth } from '../auth/session.js';
import { requireSpace, canEditBranch } from '../permissions.js';
import { audit } from '../audit.js';
import { emit } from '../events.js';
import { ah, badRequest, HttpError, notFound, parse, slugify } from '../util.js';
import { createPage, deletePageTree, savePageContent, snapshotVersion, uniqueSlug, updatePageMeta, afterMainChange } from '../content/pages.js';
import { type PMNode, emptyDoc, markdownToJson, toMarkdown } from '../content/prosemirror.js';
import { buildTree, type PageRow } from '../content/tree.js';
import { checkQuality } from '../ai/quality.js';

export const pagesRouter = Router();
pagesRouter.use(requireAuth);

/** Load a branch and the caller's role on its space; optionally require edit rights. */
async function loadBranch(req: any, spaceId: string, branchId: string, needEdit: boolean) {
  const { space, role } = await requireSpace(req, spaceId, needEdit ? 'editor' : 'reader');
  const branch = await one('SELECT * FROM branches WHERE id=? AND space_id=?', [branchId, space.id]);
  if (!branch) throw notFound('Branch');
  const canEdit = canEditBranch(space, branch, role);
  if (needEdit && !canEdit) {
    throw new HttpError(409, branch.is_main ? 'The main branch is locked: edits must go through a change request.' : 'This branch is not open for editing.', { code: 'BRANCH_LOCKED' });
  }
  return { space, role, branch, canEdit };
}

async function loadPage(req: any, pageId: string, needEdit: boolean) {
  const page = await one('SELECT * FROM pages WHERE id=?', [pageId]);
  if (!page || page.deleted) throw notFound('Page');
  const ctx = await loadBranch(req, page.space_id, page.branch_id, needEdit);
  return { ...ctx, page };
}

pagesRouter.get(
  '/spaces/:spaceId/branches/:branchId/tree',
  ah(async (req, res) => {
    const { branch, canEdit } = await loadBranch(req, req.params.spaceId, req.params.branchId, false);
    const pages = await query<PageRow>(
      `SELECT id, stable_id, parent_stable_id, title, slug, kind, position, hidden, icon, link_url, description, modified, updated_at, base_version
       FROM pages WHERE branch_id=? AND deleted=0`,
      [branch.id],
    );
    const { roots } = buildTree(pages);
    const strip = (nodes: any[]): any[] =>
      nodes.map((n) => ({
        id: n.id,
        stableId: n.stable_id,
        title: n.title,
        slug: n.slug,
        path: n.path,
        kind: n.kind,
        icon: n.icon,
        hidden: !!n.hidden,
        linkUrl: n.link_url,
        modified: !branch.is_main && !!n.modified,
        isNew: !branch.is_main && n.base_version === null,
        children: strip(n.children),
      }));
    res.json({ branch: { ...branch, is_main: !!branch.is_main }, canEdit, pages: strip(roots) });
  }),
);

const createSchema = z.object({
  title: z.string().trim().min(1).max(500).default('Untitled'),
  parentStableId: z.string().max(36).nullable().optional(),
  kind: z.enum(['doc', 'group', 'link', 'api']).optional(),
  linkUrl: z.string().max(2048).optional(),
  markdown: z.string().max(5_000_000).optional(),
  content: z.any().optional(),
  afterStableId: z.string().max(36).optional(),
});

pagesRouter.post(
  '/spaces/:spaceId/branches/:branchId/pages',
  ah(async (req, res) => {
    const { space, branch } = await loadBranch(req, req.params.spaceId, req.params.branchId, true);
    const body = parse(createSchema, req.body);
    let position: number | undefined;
    if (body.afterStableId) {
      const after = await one('SELECT position, parent_stable_id FROM pages WHERE branch_id=? AND stable_id=?', [branch.id, body.afterStableId]);
      if (after) {
        const next = await one<{ p: number }>(
          `SELECT MIN(position) AS p FROM pages WHERE branch_id=? AND position > ? AND ${after.parent_stable_id ? 'parent_stable_id=?' : 'parent_stable_id IS NULL'}`,
          [branch.id, after.position, ...(after.parent_stable_id ? [after.parent_stable_id] : [])],
        );
        position = next?.p != null ? (after.position + next.p) / 2 : after.position + 1;
        body.parentStableId = after.parent_stable_id;
      }
    }
    const content: PMNode | undefined = body.markdown ? markdownToJson(body.markdown) : body.content;
    const created = await createPage({
      spaceId: space.id,
      branchId: branch.id,
      title: body.title,
      parentStableId: body.parentStableId ?? null,
      kind: body.kind,
      linkUrl: body.linkUrl ?? null,
      content,
      position,
      userId: req.user!.id,
    });
    if (branch.is_main) void emit('page.created', { orgId: space.org_id, spaceId: space.id }, { pageId: created.stableId, title: body.title });
    res.json({ id: created.id, stableId: created.stableId });
  }),
);

/** Bulk Markdown import: [{path: "guides/setup.md", markdown}] creates a nested page tree. */
pagesRouter.post(
  '/spaces/:spaceId/branches/:branchId/import',
  ah(async (req, res) => {
    const { space, branch } = await loadBranch(req, req.params.spaceId, req.params.branchId, true);
    const body = parse(z.object({ files: z.array(z.object({ path: z.string().max(500), markdown: z.string().max(5_000_000) })).min(1).max(500), parentStableId: z.string().max(36).nullable().optional() }), req.body);
    const folders = new Map<string, string>();
    const sorted = [...body.files].sort((a, b) => a.path.localeCompare(b.path));
    let created = 0;
    for (const f of sorted) {
      const parts = f.path.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
      const file = parts.pop()!;
      let parent: string | null = body.parentStableId ?? null;
      let acc = '';
      for (const dir of parts) {
        acc += '/' + dir;
        if (!folders.has(acc)) {
          const g = await createPage({ spaceId: space.id, branchId: branch.id, title: dir.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), parentStableId: parent, userId: req.user!.id });
          folders.set(acc, g.stableId);
        }
        parent = folders.get(acc)!;
      }
      let md = f.markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
      const h1 = /^#\s+(.+)\n/.exec(md.trimStart());
      let title = file.replace(/\.(md|mdx|markdown)$/i, '').replace(/[-_]/g, ' ');
      if (h1) {
        title = h1[1].trim();
        md = md.trimStart().slice(h1[0].length);
      }
      if (/^(readme|index)$/i.test(file.replace(/\.\w+$/, '')) && parent) {
        await exec('UPDATE pages SET content=?, content_text=?, ydoc=NULL WHERE branch_id=? AND stable_id=?', [JSON.stringify(markdownToJson(md)), md, branch.id, parent]);
        continue;
      }
      await createPage({ spaceId: space.id, branchId: branch.id, title, parentStableId: parent, content: markdownToJson(md), userId: req.user!.id });
      created++;
    }
    if (branch.is_main) await afterMainChange(space.id, null);
    await audit(req, space.org_id, 'pages.imported', { type: 'space', id: space.id }, { count: created });
    res.json({ created });
  }),
);

pagesRouter.get(
  '/pages/:pageId',
  ah(async (req, res) => {
    const { page, canEdit, role, branch, space } = await loadPage(req, req.params.pageId, false);
    const editor = page.updated_by ? await one('SELECT id, name FROM users WHERE id=?', [page.updated_by]) : null;
    const { ydoc: _y, content, content_text: _t, ...rest } = page;
    res.json({
      ...rest,
      hidden: !!page.hidden,
      content: json<PMNode>(content, emptyDoc()),
      canEdit,
      role,
      branch: { id: branch.id, name: branch.name, is_main: !!branch.is_main },
      space: { id: space.id, name: space.name, org_id: space.org_id },
      updatedBy: editor,
    });
  }),
);

const metaSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  slug: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  icon: z.string().max(16).nullable().optional(),
  hidden: z.boolean().optional(),
  linkUrl: z.string().max(2048).nullable().optional(),
  kind: z.enum(['doc', 'group', 'link', 'api']).optional(),
});

pagesRouter.patch(
  '/pages/:pageId',
  ah(async (req, res) => {
    const { page } = await loadPage(req, req.params.pageId, true);
    const body = parse(metaSchema, req.body);
    const patch: Record<string, unknown> = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.slug !== undefined) patch.slug = await uniqueSlug(page.branch_id, page.parent_stable_id, slugify(body.slug), page.stable_id);
    if (body.description !== undefined) patch.description = body.description;
    if (body.icon !== undefined) patch.icon = body.icon;
    if (body.hidden !== undefined) patch.hidden = body.hidden ? 1 : 0;
    if (body.linkUrl !== undefined) patch.link_url = body.linkUrl;
    if (body.kind !== undefined) patch.kind = body.kind;
    await updatePageMeta(page.id, patch, req.user!.id);
    res.json({ ok: true, slug: patch.slug ?? page.slug });
  }),
);

pagesRouter.put(
  '/pages/:pageId/content',
  ah(async (req, res) => {
    const { page } = await loadPage(req, req.params.pageId, true);
    const body = parse(z.object({ content: z.any().optional(), markdown: z.string().max(5_000_000).optional(), message: z.string().max(500).optional(), mode: z.enum(['replace', 'append']).optional() }), req.body);
    let doc: PMNode = body.markdown !== undefined ? markdownToJson(body.markdown) : body.content;
    if (!doc || doc.type !== 'doc') throw badRequest('content must be a ProseMirror document');
    if (body.mode === 'append') {
      const cur = json<PMNode>(page.content, emptyDoc());
      doc = { type: 'doc', content: [...(cur.content || []), ...(doc.content || [])] };
    }
    await savePageContent(page.id, doc, req.user!.id, { message: body.message, forceVersion: true });
    res.json({ ok: true });
  }),
);

pagesRouter.post(
  '/pages/:pageId/move',
  ah(async (req, res) => {
    const { page, branch } = await loadPage(req, req.params.pageId, true);
    const body = parse(z.object({ parentStableId: z.string().max(36).nullable(), index: z.number().int().min(0) }), req.body);
    if (body.parentStableId) {
      // Prevent moving a page into its own subtree.
      const all = await query<{ stable_id: string; parent_stable_id: string | null }>('SELECT stable_id, parent_stable_id FROM pages WHERE branch_id=? AND deleted=0', [branch.id]);
      const parentOf = new Map(all.map((p) => [p.stable_id, p.parent_stable_id]));
      let cur: string | null | undefined = body.parentStableId;
      while (cur) {
        if (cur === page.stable_id) throw badRequest('Cannot move a page inside itself');
        cur = parentOf.get(cur);
      }
    }
    const siblings = await query<{ id: string; stable_id: string }>(
      `SELECT id, stable_id FROM pages WHERE branch_id=? AND deleted=0 AND stable_id<>? AND ${body.parentStableId ? 'parent_stable_id=?' : 'parent_stable_id IS NULL'} ORDER BY position, title`,
      [branch.id, page.stable_id, ...(body.parentStableId ? [body.parentStableId] : [])],
    );
    siblings.splice(Math.min(body.index, siblings.length), 0, { id: page.id, stable_id: page.stable_id });
    for (let i = 0; i < siblings.length; i++) {
      await exec(`UPDATE pages SET position=?${branch.is_main ? '' : ', modified=1'} WHERE id=?`, [i + 1, siblings[i].id]);
    }
    const patch: Record<string, unknown> = {};
    if ((page.parent_stable_id || null) !== (body.parentStableId || null)) {
      patch.parent_stable_id = body.parentStableId;
      patch.slug = await uniqueSlug(branch.id, body.parentStableId, page.slug, page.stable_id);
    }
    await updatePageMeta(page.id, patch, req.user!.id);
    res.json({ ok: true });
  }),
);

pagesRouter.post(
  '/pages/:pageId/duplicate',
  ah(async (req, res) => {
    const { page, space, branch } = await loadPage(req, req.params.pageId, true);
    const created = await createPage({
      spaceId: space.id,
      branchId: branch.id,
      title: `${page.title} (copy)`,
      parentStableId: page.parent_stable_id,
      kind: page.kind,
      content: json<PMNode>(page.content, emptyDoc()),
      description: page.description,
      icon: page.icon,
      position: page.position + 0.5,
      userId: req.user!.id,
    });
    res.json({ id: created.id, stableId: created.stableId });
  }),
);

pagesRouter.delete(
  '/pages/:pageId',
  ah(async (req, res) => {
    const { page, branch, space } = await loadPage(req, req.params.pageId, true);
    const ids = await deletePageTree(branch.id, page.stable_id);
    await audit(req, space.org_id, 'page.deleted', { type: 'page', id: page.stable_id }, { title: page.title, branch: branch.name, count: ids.length });
    if (branch.is_main) void emit('page.deleted', { orgId: space.org_id, spaceId: space.id }, { pageId: page.stable_id, title: page.title });
    res.json({ ok: true, deleted: ids.length });
  }),
);

// ---- Version history --------------------------------------------------------------------------

pagesRouter.get(
  '/pages/:pageId/versions',
  ah(async (req, res) => {
    const { page } = await loadPage(req, req.params.pageId, false);
    const rows = await query(
      `SELECT v.id, v.title, v.version, v.message, v.created_at, u.name AS author FROM page_versions v LEFT JOIN users u ON u.id=v.created_by
       WHERE v.space_id=? AND v.stable_id=? ORDER BY v.created_at DESC LIMIT 200`,
      [page.space_id, page.stable_id],
    );
    res.json(rows);
  }),
);

pagesRouter.post(
  '/pages/:pageId/versions',
  ah(async (req, res) => {
    const { page } = await loadPage(req, req.params.pageId, true);
    const { message } = parse(z.object({ message: z.string().trim().max(500).optional() }), req.body);
    await snapshotVersion(page, req.user!.id, message || 'Saved version', true);
    res.json({ ok: true });
  }),
);

pagesRouter.get(
  '/pages/:pageId/versions/:versionId',
  ah(async (req, res) => {
    const { page } = await loadPage(req, req.params.pageId, false);
    const v = await one('SELECT * FROM page_versions WHERE id=? AND stable_id=? AND space_id=?', [req.params.versionId, page.stable_id, page.space_id]);
    if (!v) throw notFound('Version');
    const before = toMarkdown(json<PMNode>(v.content, emptyDoc()));
    const after = toMarkdown(json<PMNode>(page.content, emptyDoc()));
    res.json({ ...v, content: json<PMNode>(v.content, emptyDoc()), diff: diffLines(before, after) });
  }),
);

pagesRouter.post(
  '/pages/:pageId/versions/:versionId/restore',
  ah(async (req, res) => {
    const { page, space } = await loadPage(req, req.params.pageId, true);
    const v = await one('SELECT * FROM page_versions WHERE id=? AND stable_id=? AND space_id=?', [req.params.versionId, page.stable_id, page.space_id]);
    if (!v) throw notFound('Version');
    await savePageContent(page.id, json<PMNode>(v.content, emptyDoc()), req.user!.id, { message: `Restored version from ${new Date(v.created_at).toISOString()}`, forceVersion: true });
    if (v.title !== page.title) await updatePageMeta(page.id, { title: v.title }, req.user!.id);
    await audit(req, space.org_id, 'page.restored', { type: 'page', id: page.stable_id }, { versionId: v.id });
    res.json({ ok: true });
  }),
);

// ---- Export / quality -------------------------------------------------------------------------

pagesRouter.get(
  '/pages/:pageId/markdown',
  ah(async (req, res) => {
    const { page } = await loadPage(req, req.params.pageId, false);
    const md = `# ${page.title}\n\n${toMarkdown(json<PMNode>(page.content, emptyDoc()))}`;
    res.type('text/markdown').setHeader('Content-Disposition', `attachment; filename="${page.slug}.md"`);
    res.send(md);
  }),
);

pagesRouter.get(
  '/pages/:pageId/quality',
  ah(async (req, res) => {
    const { page, branch } = await loadPage(req, req.params.pageId, false);
    const all = await query<{ stable_id: string; title: string }>('SELECT stable_id, title FROM pages WHERE branch_id=? AND deleted=0', [branch.id]);
    const dup = all.filter((p) => p.title.toLowerCase() === page.title.toLowerCase()).length > 1;
    res.json(checkQuality(page, json<PMNode>(page.content, emptyDoc()), { knownStableIds: new Set(all.map((p) => p.stable_id)), duplicateTitle: dup }));
  }),
);

/** Lightweight branch-scoped search for the editor (page picker, link insert, quick find). */
pagesRouter.get(
  '/spaces/:spaceId/branches/:branchId/search',
  ah(async (req, res) => {
    const { branch } = await loadBranch(req, req.params.spaceId, req.params.branchId, false);
    const q = String(req.query.q || '').trim();
    if (!q) return void res.json([]);
    const rows = await query(
      `SELECT id, stable_id, title, LEFT(content_text, 240) AS excerpt, MATCH(title, content_text) AGAINST (? IN NATURAL LANGUAGE MODE) AS score
       FROM pages WHERE branch_id=? AND deleted=0 AND (title LIKE ? OR MATCH(title, content_text) AGAINST (? IN NATURAL LANGUAGE MODE))
       ORDER BY (title LIKE ?) DESC, score DESC LIMIT 20`,
      [q, branch.id, `%${q}%`, q, `%${q}%`],
    );
    res.json(rows.map((r) => ({ id: r.id, stableId: r.stable_id, title: r.title, excerpt: r.excerpt })));
  }),
);

/** Markdown <-> document conversion used by the editor (paste, import, AI output, copy as Markdown). */
pagesRouter.post(
  '/markdown/parse',
  ah(async (req, res) => {
    const { markdown } = parse(z.object({ markdown: z.string().max(5_000_000) }), req.body);
    res.json(markdownToJson(markdown));
  }),
);

pagesRouter.post(
  '/markdown/serialize',
  ah(async (req, res) => {
    const { content } = parse(z.object({ content: z.any() }), req.body);
    if (!content || content.type !== 'doc') throw badRequest('content must be a document');
    res.json({ markdown: toMarkdown(content) });
  }),
);
