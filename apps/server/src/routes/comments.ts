import { Router } from 'express';
import { z } from 'zod';
import { exec, insert, one, query } from '../db.js';
import { requireAuth } from '../auth/session.js';
import { requireSpace, atLeast } from '../permissions.js';
import { emit, notify } from '../events.js';
import { ah, forbidden, notFound, parse, uuid } from '../util.js';

export const commentsRouter = Router();
commentsRouter.use(requireAuth);

commentsRouter.get(
  '/spaces/:spaceId/comments',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId);
    const pageStableId = typeof req.query.pageStableId === 'string' ? req.query.pageStableId : null;
    const crId = typeof req.query.crId === 'string' ? req.query.crId : null;
    const rows = await query(
      `SELECT c.*, u.name AS author_name, u.avatar_url AS author_avatar FROM comments c LEFT JOIN users u ON u.id=c.author_id
       WHERE c.space_id=? ${pageStableId ? 'AND c.page_stable_id=?' : ''} ${crId ? 'AND c.cr_id=?' : pageStableId ? '' : 'AND c.cr_id IS NULL'} ORDER BY c.created_at`,
      [space.id, ...(pageStableId ? [pageStableId] : []), ...(crId ? [crId] : [])],
    );
    const threads = new Map<string, any>();
    for (const r of rows) {
      const c = { ...r, resolved: !!r.resolved };
      if (!r.parent_id) threads.set(r.thread_id, { ...c, replies: [] });
    }
    for (const r of rows) if (r.parent_id && threads.has(r.thread_id)) threads.get(r.thread_id).replies.push({ ...r, resolved: !!r.resolved });
    res.json([...threads.values()]);
  }),
);

const createSchema = z.object({
  body: z.string().trim().min(1).max(10000),
  pageStableId: z.string().max(36).nullable().optional(),
  branchId: z.string().max(36).nullable().optional(),
  crId: z.string().max(36).nullable().optional(),
  threadId: z.string().uuid().optional(),
  parentId: z.string().max(36).optional(),
  quote: z.string().max(2000).optional(),
});

commentsRouter.post(
  '/spaces/:spaceId/comments',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'commenter');
    const body = parse(createSchema, req.body);
    let threadId = body.threadId || uuid();
    let parentId: string | null = null;
    let parent: any = null;
    if (body.parentId) {
      parent = await one('SELECT * FROM comments WHERE id=? AND space_id=?', [body.parentId, space.id]);
      if (!parent) throw notFound('Comment');
      threadId = parent.thread_id;
      parentId = parent.parent_id || parent.id;
    }
    const id = uuid();
    await insert('comments', {
      id,
      space_id: space.id,
      page_stable_id: parent?.page_stable_id ?? body.pageStableId ?? null,
      branch_id: parent?.branch_id ?? body.branchId ?? null,
      cr_id: parent?.cr_id ?? body.crId ?? null,
      thread_id: threadId,
      parent_id: parentId,
      author_id: req.user!.id,
      body: body.body,
      quote: body.quote ?? null,
    });
    // Notify @mentions (format: @[Name](user:ID)) and earlier participants in the thread.
    const mentioned = [...body.body.matchAll(/@\[[^\]]+\]\(user:([0-9a-f-]{36})\)/g)].map((m) => m[1]);
    const participants = parent ? (await query<{ author_id: string }>('SELECT DISTINCT author_id FROM comments WHERE thread_id=?', [threadId])).map((r) => r.author_id) : [];
    const recipients = [...new Set([...mentioned, ...participants])].filter((u) => u && u !== req.user!.id);
    if (recipients.length) {
      const org = await one('SELECT slug FROM organizations WHERE id=?', [space.org_id]);
      let link = `/o/${org!.slug}/s/${space.id}`;
      const crId = parent?.cr_id ?? body.crId;
      if (crId) {
        const cr = await one('SELECT number FROM change_requests WHERE id=?', [crId]);
        if (cr) link += `/cr/${cr.number}`;
      } else if (body.branchId || parent?.branch_id) {
        const pageId = await one('SELECT id FROM pages WHERE branch_id=? AND stable_id=?', [parent?.branch_id ?? body.branchId, parent?.page_stable_id ?? body.pageStableId]);
        if (pageId) link += `/b/${parent?.branch_id ?? body.branchId}/p/${pageId.id}`;
      }
      await notify(recipients, { type: 'comment', title: `${req.user!.name} ${mentioned.length ? 'mentioned you' : 'replied'} in a comment`, body: body.body.slice(0, 300), link });
    }
    void emit('comment.created', { orgId: space.org_id, spaceId: space.id }, { commentId: id, threadId, author: req.user!.name, pageId: body.pageStableId ?? null });
    res.json({ id, threadId });
  }),
);

commentsRouter.patch(
  '/spaces/:spaceId/comments/:id',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'commenter');
    const c = await one('SELECT * FROM comments WHERE id=? AND space_id=?', [req.params.id, space.id]);
    if (!c) throw notFound('Comment');
    if (c.author_id !== req.user!.id) throw forbidden('You can only edit your own comments');
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(10000) }), req.body);
    await exec('UPDATE comments SET body=?, updated_at=NOW(3) WHERE id=?', [body, c.id]);
    res.json({ ok: true });
  }),
);

commentsRouter.post(
  '/spaces/:spaceId/comments/threads/:threadId/resolve',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'commenter');
    const resolved = req.body?.resolved !== false;
    await exec('UPDATE comments SET resolved=? WHERE thread_id=? AND space_id=?', [resolved ? 1 : 0, req.params.threadId, space.id]);
    res.json({ ok: true });
  }),
);

commentsRouter.delete(
  '/spaces/:spaceId/comments/:id',
  ah(async (req, res) => {
    const { space, role } = await requireSpace(req, req.params.spaceId, 'commenter');
    const c = await one('SELECT * FROM comments WHERE id=? AND space_id=?', [req.params.id, space.id]);
    if (!c) throw notFound('Comment');
    if (c.author_id !== req.user!.id && !atLeast(role, 'admin')) throw forbidden();
    if (!c.parent_id) await exec('DELETE FROM comments WHERE thread_id=?', [c.thread_id]);
    else await exec('DELETE FROM comments WHERE id=?', [c.id]);
    res.json({ ok: true, thread: !c.parent_id });
  }),
);
