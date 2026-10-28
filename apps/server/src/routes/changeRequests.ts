import { Router } from 'express';
import { z } from 'zod';
import { diffLines, diffWords } from 'diff';
import { exec, insert, json, one, query, tx } from '../db.js';
import { requireAuth } from '../auth/session.js';
import { requireSpace, atLeast, getSpaceRole, type SpaceSettings } from '../permissions.js';
import { audit } from '../audit.js';
import { emit, notify } from '../events.js';
import { ah, badRequest, HttpError, notFound, parse, uuid } from '../util.js';
import { branchChanges, createBranch, mergeBranch } from '../content/pages.js';
import { type PMNode, emptyDoc, toMarkdown } from '../content/prosemirror.js';

export const crRouter = Router();
crRouter.use(requireAuth);

async function loadCr(spaceId: string, number: string | number) {
  const cr = await one(
    `SELECT c.*, u.name AS author_name, mu.name AS merged_by_name, b.name AS branch_name, b.status AS branch_status
     FROM change_requests c JOIN branches b ON b.id=c.branch_id LEFT JOIN users u ON u.id=c.author_id LEFT JOIN users mu ON mu.id=c.merged_by
     WHERE c.space_id=? AND c.number=?`,
    [spaceId, Number(number)],
  );
  if (!cr) throw notFound('Change request');
  return cr;
}

crRouter.get(
  '/spaces/:spaceId/change-requests',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId);
    const status = String(req.query.status || 'open');
    const rows = await query(
      `SELECT c.id, c.number, c.title, c.status, c.created_at, c.updated_at, c.branch_id, u.name AS author_name,
        (SELECT COUNT(*) FROM reviews r WHERE r.cr_id=c.id AND r.state='approved') AS approvals,
        (SELECT COUNT(*) FROM comments m WHERE m.cr_id=c.id) AS comments
       FROM change_requests c LEFT JOIN users u ON u.id=c.author_id WHERE c.space_id=? ${status === 'all' ? '' : 'AND c.status IN (?)'} ORDER BY c.number DESC LIMIT 200`,
      [space.id, ...(status === 'all' ? [] : [status === 'open' ? ['open', 'draft'] : [status]])],
    );
    res.json(rows);
  }),
);

crRouter.post(
  '/spaces/:spaceId/change-requests',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'editor');
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(500),
        description: z.string().max(20000).optional(),
        branchId: z.string().max(36).optional(),
        reviewers: z.array(z.string().max(36)).max(20).optional(),
        draft: z.boolean().optional(),
      }),
      req.body,
    );
    let branchId = body.branchId;
    if (branchId) {
      const b = await one('SELECT * FROM branches WHERE id=? AND space_id=?', [branchId, space.id]);
      if (!b || b.is_main || b.status !== 'open') throw badRequest('Choose an open branch');
      const existing = await one("SELECT number FROM change_requests WHERE branch_id=? AND status IN ('open','draft')", [branchId]);
      if (existing) throw badRequest(`Change request #${existing.number} is already open for this branch`);
    } else {
      branchId = await createBranch(space.id, body.title, req.user!.id);
    }
    const id = uuid();
    const number = await tx(async (conn) => {
      const last = await one<{ n: number | null }>('SELECT MAX(number) AS n FROM change_requests WHERE space_id=? FOR UPDATE', [space.id], conn);
      const n = (last?.n ?? 0) + 1;
      await insert('change_requests', { id, space_id: space.id, branch_id: branchId, number: n, title: body.title, description: body.description ?? null, status: body.draft ? 'draft' : 'open', author_id: req.user!.id }, conn);
      for (const r of body.reviewers || []) await insert('review_requests', { cr_id: id, user_id: r }, conn);
      return n;
    });
    if (body.reviewers?.length) {
      const org = await one('SELECT slug FROM organizations WHERE id=?', [space.org_id]);
      await notify(body.reviewers, { type: 'review_requested', title: `${req.user!.name} requested your review on "${body.title}"`, link: `/o/${org!.slug}/s/${space.id}/cr/${number}` });
    }
    await audit(req, space.org_id, 'change_request.created', { type: 'change_request', id }, { number, title: body.title });
    void emit('change_request.created', { orgId: space.org_id, spaceId: space.id }, { number, title: body.title, author: req.user!.name });
    res.json({ id, number, branchId });
  }),
);

crRouter.get(
  '/spaces/:spaceId/change-requests/:number',
  ah(async (req, res) => {
    const { space, role } = await requireSpace(req, req.params.spaceId);
    const cr = await loadCr(space.id, req.params.number);
    const settings = json<SpaceSettings>(space.settings, {});
    const reviews = await query('SELECT r.*, u.name AS user_name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.cr_id=? ORDER BY r.created_at', [cr.id]);
    const reviewers = await query('SELECT u.id, u.name, u.email FROM review_requests rr JOIN users u ON u.id=rr.user_id WHERE rr.cr_id=?', [cr.id]);
    let changes: any[] = [];
    if (cr.status === 'open' || cr.status === 'draft') {
      const raw = await branchChanges(cr.branch_id);
      changes = raw.map((c) => {
        const before = c.mainPage ? toMarkdown(json<PMNode>(c.mainPage.content, emptyDoc())) : '';
        const after = c.type === 'deleted' ? '' : toMarkdown(json<PMNode>(c.branchPage.content, emptyDoc()));
        const meta: { field: string; from: unknown; to: unknown }[] = [];
        if (c.mainPage && c.type === 'modified') {
          for (const f of ['title', 'slug', 'description', 'icon', 'parent_stable_id', 'hidden', 'kind']) {
            if (String(c.mainPage[f] ?? '') !== String(c.branchPage[f] ?? '')) meta.push({ field: f, from: c.mainPage[f], to: c.branchPage[f] });
          }
        }
        return {
          stableId: c.stableId,
          pageId: c.branchPage.id,
          title: c.title,
          type: c.type,
          conflict: c.conflict,
          meta,
          diff: diffLines(before, after).map((d) => ({ value: d.value, added: !!d.added, removed: !!d.removed })),
          stats: { added: diffWords(before, after).filter((d) => d.added).reduce((a, d) => a + d.value.split(/\s+/).filter(Boolean).length, 0), removed: diffWords(before, after).filter((d) => d.removed).reduce((a, d) => a + d.value.split(/\s+/).filter(Boolean).length, 0) },
        };
      });
    }
    // Latest review per user decides approval state.
    const latest = new Map<string, any>();
    for (const r of reviews) if (r.state !== 'commented') latest.set(r.user_id, r);
    const approvals = [...latest.values()].filter((r) => r.state === 'approved').length;
    const changesRequested = [...latest.values()].some((r) => r.state === 'changes_requested');
    const required = settings.requireApprovals ?? 0;
    const conflicts = changes.filter((c) => c.conflict).length;
    const canMerge = atLeast(role, 'editor') && cr.status === 'open' && approvals >= required && !changesRequested && changes.length > 0;
    res.json({ ...cr, reviews, reviewers, changes, approvals, requiredApprovals: required, changesRequested, conflicts, canMerge, role });
  }),
);

crRouter.patch(
  '/spaces/:spaceId/change-requests/:number',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'editor');
    const cr = await loadCr(space.id, req.params.number);
    const body = parse(z.object({ title: z.string().trim().min(1).max(500).optional(), description: z.string().max(20000).nullable().optional(), status: z.enum(['open', 'draft', 'closed']).optional() }), req.body);
    if (cr.status === 'merged') throw badRequest('Merged change requests cannot be edited');
    if (body.status === 'open' && cr.branch_status !== 'open') throw badRequest('The branch for this change request was closed');
    await exec('UPDATE change_requests SET title=COALESCE(?, title), description=?, status=COALESCE(?, status), updated_at=NOW(3) WHERE id=?', [body.title ?? null, body.description === undefined ? cr.description : body.description, body.status ?? null, cr.id]);
    if (body.status === 'closed') {
      await audit(req, space.org_id, 'change_request.closed', { type: 'change_request', id: cr.id }, { number: cr.number });
      void emit('change_request.closed', { orgId: space.org_id, spaceId: space.id }, { number: cr.number, title: cr.title });
    } else void emit('change_request.updated', { orgId: space.org_id, spaceId: space.id }, { number: cr.number });
    res.json({ ok: true });
  }),
);

crRouter.post(
  '/spaces/:spaceId/change-requests/:number/reviewers',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId, 'editor');
    const cr = await loadCr(space.id, req.params.number);
    const { userIds } = parse(z.object({ userIds: z.array(z.string().max(36)).max(20) }), req.body);
    await exec('DELETE FROM review_requests WHERE cr_id=?', [cr.id]);
    for (const u of userIds) await insert('review_requests', { cr_id: cr.id, user_id: u });
    const org = await one('SELECT slug FROM organizations WHERE id=?', [space.org_id]);
    await notify(userIds, { type: 'review_requested', title: `${req.user!.name} requested your review on "${cr.title}"`, link: `/o/${org!.slug}/s/${space.id}/cr/${cr.number}` });
    res.json({ ok: true });
  }),
);

crRouter.post(
  '/spaces/:spaceId/change-requests/:number/reviews',
  ah(async (req, res) => {
    const { space, role } = await requireSpace(req, req.params.spaceId, 'commenter');
    const cr = await loadCr(space.id, req.params.number);
    const body = parse(z.object({ state: z.enum(['approved', 'changes_requested', 'commented']), body: z.string().max(20000).optional() }), req.body);
    if (body.state !== 'commented' && !atLeast(role, 'reviewer')) throw new HttpError(403, 'Only reviewers can approve or request changes');
    if (body.state === 'approved' && cr.author_id === req.user!.id && !req.user!.is_admin) throw badRequest('You cannot approve your own change request');
    if (cr.status !== 'open' && cr.status !== 'draft') throw badRequest('This change request is not open');
    await insert('reviews', { id: uuid(), cr_id: cr.id, user_id: req.user!.id, state: body.state, body: body.body ?? null });
    if (cr.author_id && cr.author_id !== req.user!.id) {
      const org = await one('SELECT slug FROM organizations WHERE id=?', [space.org_id]);
      const verb = body.state === 'approved' ? 'approved' : body.state === 'changes_requested' ? 'requested changes on' : 'commented on';
      await notify([cr.author_id], { type: 'review', title: `${req.user!.name} ${verb} "${cr.title}"`, body: body.body, link: `/o/${org!.slug}/s/${space.id}/cr/${cr.number}` });
    }
    await audit(req, space.org_id, 'review.submitted', { type: 'change_request', id: cr.id }, { state: body.state });
    void emit('review.submitted', { orgId: space.org_id, spaceId: space.id }, { number: cr.number, state: body.state, reviewer: req.user!.name });
    res.json({ ok: true });
  }),
);

crRouter.post(
  '/spaces/:spaceId/change-requests/:number/merge',
  ah(async (req, res) => {
    const { space, role } = await requireSpace(req, req.params.spaceId, 'editor');
    const cr = await loadCr(space.id, req.params.number);
    if (cr.status !== 'open') throw badRequest(cr.status === 'draft' ? 'Mark the change request as ready before merging' : 'This change request is not open');
    const force = req.body?.force === true;
    if (force && !atLeast(role, 'admin')) throw new HttpError(403, 'Only space admins can override conflicts');
    const settings = json<SpaceSettings>(space.settings, {});
    const reviews = await query("SELECT user_id, state FROM reviews WHERE cr_id=? AND state<>'commented' ORDER BY created_at", [cr.id]);
    const latest = new Map<string, string>();
    for (const r of reviews) latest.set(r.user_id, r.state);
    const approvals = [...latest.values()].filter((s) => s === 'approved').length;
    if (approvals < (settings.requireApprovals ?? 0) && !atLeast(role, 'admin')) throw badRequest(`This space requires ${settings.requireApprovals} approval(s) before merging`);
    if ([...latest.values()].includes('changes_requested') && !force) throw badRequest('A reviewer requested changes');
    const result = await mergeBranch(cr.branch_id, req.user!.id, force);
    if (result.conflicts.length) return void res.status(409).json({ error: 'Merge conflicts', conflicts: result.conflicts });
    await exec("UPDATE change_requests SET status='merged', merged_by=?, merged_at=NOW(3), updated_at=NOW(3) WHERE id=?", [req.user!.id, cr.id]);
    await audit(req, space.org_id, 'change_request.merged', { type: 'change_request', id: cr.id }, { number: cr.number, pages: result.merged, force });
    void emit('change_request.merged', { orgId: space.org_id, spaceId: space.id }, { number: cr.number, title: cr.title, mergedBy: req.user!.name, pages: result.merged });
    if (cr.author_id && cr.author_id !== req.user!.id) {
      const org = await one('SELECT slug FROM organizations WHERE id=?', [space.org_id]);
      await notify([cr.author_id], { type: 'merged', title: `${req.user!.name} merged "${cr.title}"`, link: `/o/${org!.slug}/s/${space.id}/cr/${cr.number}` });
    }
    res.json({ ok: true, merged: result.merged });
  }),
);

/** Users that can be requested as reviewers on a space. */
crRouter.get(
  '/spaces/:spaceId/reviewers',
  ah(async (req, res) => {
    const { space } = await requireSpace(req, req.params.spaceId);
    const members = await query('SELECT u.id, u.name, u.email FROM org_members m JOIN users u ON u.id=m.user_id WHERE m.org_id=? ORDER BY u.name', [space.org_id]);
    const out = [];
    for (const m of members) {
      const role = await getSpaceRole(m.id, false, space);
      if (atLeast(role, 'reviewer')) out.push({ ...m, role });
    }
    res.json(out);
  }),
);
