import { Router } from 'express';
import { z } from 'zod';
import { exec, insert, json, one, query, tx } from '../db.js';
import { requireAuth } from '../auth/session.js';
import { requireOrg, ROLES, atLeast, getSpaceRole, type OrgSettings } from '../permissions.js';
import { audit } from '../audit.js';
import { emit, WEBHOOK_EVENTS, deliver } from '../events.js';
import { ah, badRequest, forbidden, notFound, parse, randomToken, slugify, uuid } from '../util.js';
import { config } from '../config.js';
import { type PMNode, emptyDoc, extractText } from '../content/prosemirror.js';
import { createSpaceWithDefaults } from './spaces.js';

export const orgsRouter = Router();
orgsRouter.use(requireAuth);

const roleEnum = z.enum(ROLES);

orgsRouter.post(
  '/',
  ah(async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(120), slug: z.string().trim().max(80).optional() }), req.body);
    let slug = slugify(body.slug || body.name);
    if (await one('SELECT id FROM organizations WHERE slug=?', [slug])) slug = `${slug}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const id = uuid();
    await tx(async (conn) => {
      await insert('organizations', { id, name: body.name, slug, settings: {} }, conn);
      await insert('org_members', { org_id: id, user_id: req.user!.id, role: 'owner' }, conn);
    });
    await audit(req, id, 'org.created', { type: 'org', id });
    res.json({ id, slug });
  }),
);

orgsRouter.get(
  '/:org',
  ah(async (req, res) => {
    const { org, role } = await requireOrg(req, req.params.org);
    const counts = await one(
      `SELECT (SELECT COUNT(*) FROM org_members WHERE org_id=?) AS members, (SELECT COUNT(*) FROM spaces WHERE org_id=?) AS spaces, (SELECT COUNT(*) FROM teams WHERE org_id=?) AS teams`,
      [org.id, org.id, org.id],
    );
    res.json({ ...org, settings: json<OrgSettings>(org.settings, {}), role, counts });
  }),
);

orgsRouter.patch(
  '/:org',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        slug: z.string().trim().min(2).max(80).optional(),
        logo_url: z.string().max(1024).nullable().optional(),
        settings: z
          .object({
            enforce2fa: z.boolean().optional(),
            ipAllowlist: z.array(z.string().max(64)).max(100).optional(),
            allowedEmailDomains: z.array(z.string().max(255)).max(50).optional(),
            defaultSpaceRole: roleEnum.optional(),
          })
          .optional(),
      }),
      req.body,
    );
    if (body.slug) {
      body.slug = slugify(body.slug);
      if (await one('SELECT id FROM organizations WHERE slug=? AND id<>?', [body.slug, org.id])) throw badRequest('That URL is already taken');
    }
    if (body.settings?.enforce2fa && !req.user!.totp_enabled) throw badRequest('Enable two-factor authentication on your own account before enforcing it.');
    const settings = body.settings ? { ...json<OrgSettings>(org.settings, {}), ...body.settings } : undefined;
    await exec('UPDATE organizations SET name=COALESCE(?, name), slug=COALESCE(?, slug), logo_url=?, settings=COALESCE(?, settings) WHERE id=?', [
      body.name ?? null,
      body.slug ?? null,
      body.logo_url === undefined ? org.logo_url : body.logo_url,
      settings ? JSON.stringify(settings) : null,
      org.id,
    ]);
    await audit(req, org.id, 'org.updated', { type: 'org', id: org.id }, { fields: Object.keys(body) });
    res.json({ ok: true });
  }),
);

orgsRouter.delete(
  '/:org',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'owner');
    if (req.body?.confirm !== org.slug) throw badRequest('Type the organization URL to confirm deletion');
    await exec('DELETE FROM organizations WHERE id=?', [org.id]);
    await audit(req, null, 'org.deleted', { type: 'org', id: org.id }, { name: org.name });
    res.json({ ok: true });
  }),
);

// ---- Members ------------------------------------------------------------------------------

orgsRouter.get(
  '/:org/members',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org);
    const rows = await query(
      `SELECT u.id, u.name, u.email, u.avatar_url, u.totp_enabled, u.last_login_at, m.role, m.created_at
       FROM org_members m JOIN users u ON u.id=m.user_id WHERE m.org_id=? ORDER BY u.name`,
      [org.id],
    );
    res.json(rows.map((r) => ({ ...r, totp_enabled: !!r.totp_enabled })));
  }),
);

orgsRouter.patch(
  '/:org/members/:userId',
  ah(async (req, res) => {
    const { org, role: myRole } = await requireOrg(req, req.params.org, 'admin');
    const { role } = parse(z.object({ role: roleEnum }), req.body);
    const target = await one('SELECT role FROM org_members WHERE org_id=? AND user_id=?', [org.id, req.params.userId]);
    if (!target) throw notFound('Member');
    if ((role === 'owner' || target.role === 'owner') && myRole !== 'owner') throw forbidden('Only owners can grant or revoke ownership');
    if (target.role === 'owner' && role !== 'owner') {
      const owners = await one<{ n: number }>("SELECT COUNT(*) AS n FROM org_members WHERE org_id=? AND role='owner'", [org.id]);
      if ((owners?.n ?? 0) <= 1) throw badRequest('An organization needs at least one owner');
    }
    await exec('UPDATE org_members SET role=? WHERE org_id=? AND user_id=?', [role, org.id, req.params.userId]);
    await audit(req, org.id, 'member.role_changed', { type: 'user', id: req.params.userId }, { from: target.role, to: role });
    res.json({ ok: true });
  }),
);

orgsRouter.delete(
  '/:org/members/:userId',
  ah(async (req, res) => {
    const self = req.params.userId === req.user!.id;
    const { org, role: myRole } = await requireOrg(req, req.params.org, self ? 'reader' : 'admin');
    const target = await one('SELECT role FROM org_members WHERE org_id=? AND user_id=?', [org.id, req.params.userId]);
    if (!target) throw notFound('Member');
    if (target.role === 'owner') {
      if (myRole !== 'owner') throw forbidden();
      const owners = await one<{ n: number }>("SELECT COUNT(*) AS n FROM org_members WHERE org_id=? AND role='owner'", [org.id]);
      if ((owners?.n ?? 0) <= 1) throw badRequest('An organization needs at least one owner');
    }
    await exec('DELETE FROM org_members WHERE org_id=? AND user_id=?', [org.id, req.params.userId]);
    await exec('DELETE tm FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.org_id=? AND tm.user_id=?', [org.id, req.params.userId]);
    await exec("DELETE sp FROM space_permissions sp JOIN spaces s ON s.id=sp.space_id WHERE s.org_id=? AND sp.subject_type='user' AND sp.subject_id=?", [org.id, req.params.userId]);
    await audit(req, org.id, 'member.removed', { type: 'user', id: req.params.userId });
    void emit('member.removed', { orgId: org.id }, { userId: req.params.userId });
    res.json({ ok: true });
  }),
);

// ---- Invitations --------------------------------------------------------------------------

orgsRouter.get(
  '/:org/invitations',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    const rows = await query('SELECT id, email, role, token, expires_at, created_at FROM invitations WHERE org_id=? AND accepted_at IS NULL AND expires_at > NOW(3) ORDER BY created_at DESC', [org.id]);
    res.json(rows.map((r) => ({ ...r, url: `${config.appUrl}/invite/${r.token}` })));
  }),
);

orgsRouter.post(
  '/:org/invitations',
  ah(async (req, res) => {
    const { org, role: myRole } = await requireOrg(req, req.params.org, 'admin');
    const body = parse(z.object({ email: z.string().trim().toLowerCase().email().optional().or(z.literal('')), role: roleEnum, days: z.number().int().min(1).max(90).optional() }), req.body);
    if (body.role === 'owner' && myRole !== 'owner') throw forbidden('Only owners can invite owners');
    const domains = json<OrgSettings>(org.settings, {}).allowedEmailDomains || [];
    if (body.email && domains.length && !domains.some((d) => body.email!.endsWith('@' + d.replace(/^@/, '')))) {
      throw badRequest(`Only ${domains.join(', ')} email addresses may join this organization`);
    }
    const token = randomToken(24);
    const id = uuid();
    await insert('invitations', { id, org_id: org.id, email: body.email || null, role: body.role, token, created_by: req.user!.id, expires_at: new Date(Date.now() + (body.days || 14) * 86400_000) });
    await audit(req, org.id, 'member.invited', { type: 'invitation', id }, { email: body.email, role: body.role });
    res.json({ id, token, url: `${config.appUrl}/invite/${token}` });
  }),
);

orgsRouter.delete(
  '/:org/invitations/:id',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    await exec('DELETE FROM invitations WHERE id=? AND org_id=?', [req.params.id, org.id]);
    res.json({ ok: true });
  }),
);

// ---- Teams --------------------------------------------------------------------------------

orgsRouter.get(
  '/:org/teams',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org);
    const teams = await query('SELECT * FROM teams WHERE org_id=? ORDER BY name', [org.id]);
    const members = await query('SELECT tm.team_id, u.id, u.name, u.email FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN teams t ON t.id=tm.team_id WHERE t.org_id=?', [org.id]);
    res.json(teams.map((t) => ({ ...t, members: members.filter((m) => m.team_id === t.id).map(({ team_id: _t, ...m }) => m) })));
  }),
);

orgsRouter.post(
  '/:org/teams',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    const body = parse(z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(500).optional() }), req.body);
    const id = uuid();
    await insert('teams', { id, org_id: org.id, name: body.name, description: body.description ?? null });
    await audit(req, org.id, 'team.created', { type: 'team', id }, { name: body.name });
    res.json({ id });
  }),
);

orgsRouter.patch(
  '/:org/teams/:teamId',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    const body = parse(z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(500).nullable().optional() }), req.body);
    await exec('UPDATE teams SET name=COALESCE(?, name), description=? WHERE id=? AND org_id=?', [body.name ?? null, body.description ?? null, req.params.teamId, org.id]);
    res.json({ ok: true });
  }),
);

orgsRouter.delete(
  '/:org/teams/:teamId',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    await exec('DELETE FROM teams WHERE id=? AND org_id=?', [req.params.teamId, org.id]);
    await exec("DELETE FROM space_permissions WHERE subject_type='team' AND subject_id=?", [req.params.teamId]);
    await audit(req, org.id, 'team.deleted', { type: 'team', id: req.params.teamId });
    res.json({ ok: true });
  }),
);

orgsRouter.put(
  '/:org/teams/:teamId/members',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    const { userIds } = parse(z.object({ userIds: z.array(z.string().max(36)).max(1000) }), req.body);
    const team = await one('SELECT id FROM teams WHERE id=? AND org_id=?', [req.params.teamId, org.id]);
    if (!team) throw notFound('Team');
    const valid = userIds.length ? await query<{ user_id: string }>('SELECT user_id FROM org_members WHERE org_id=? AND user_id IN (?)', [org.id, userIds]) : [];
    await tx(async (conn) => {
      await exec('DELETE FROM team_members WHERE team_id=?', [team.id], conn);
      for (const v of valid) await insert('team_members', { team_id: team.id, user_id: v.user_id }, conn);
    });
    await audit(req, org.id, 'team.members_updated', { type: 'team', id: team.id }, { count: valid.length });
    res.json({ ok: true });
  }),
);

// ---- Spaces in org --------------------------------------------------------------------------

orgsRouter.get(
  '/:org/spaces',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org);
    const spaces = await query(
      `SELECT s.id, s.name, s.slug, s.description, s.icon, s.visibility, s.published, s.custom_domain, s.settings, s.org_id, s.updated_at,
         (SELECT COUNT(*) FROM pages p JOIN branches b ON b.id=p.branch_id WHERE b.space_id=s.id AND b.is_main=1 AND p.deleted=0) AS page_count,
         (SELECT COUNT(*) FROM change_requests c WHERE c.space_id=s.id AND c.status='open') AS open_crs
       FROM spaces s WHERE s.org_id=? ORDER BY s.name`,
      [org.id],
    );
    const visible = [];
    for (const s of spaces) {
      const role = await getSpaceRole(req.user!.id, req.user!.is_admin, s);
      if (role) visible.push({ ...s, settings: undefined, role });
    }
    res.json(visible);
  }),
);

orgsRouter.post(
  '/:org/spaces',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'creator');
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(120),
        description: z.string().max(1000).optional(),
        icon: z.string().max(16).optional(),
        template: z.enum(['blank', 'product', 'api']).optional(),
      }),
      req.body,
    );
    const space = await createSpaceWithDefaults(org.id, req.user!.id, body);
    await audit(req, org.id, 'space.created', { type: 'space', id: space.id }, { name: body.name });
    void emit('space.created', { orgId: org.id, spaceId: space.id }, { name: body.name });
    res.json(space);
  }),
);

// ---- Reusable content -----------------------------------------------------------------------

orgsRouter.get(
  '/:org/reusable',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org);
    res.json(
      await query(
        `SELECT r.id, r.name, r.description, r.updated_at, u.name AS updated_by_name, LEFT(r.content_text, 200) AS preview
         FROM reusable_blocks r LEFT JOIN users u ON u.id=r.updated_by WHERE r.org_id=? ORDER BY r.name`,
        [org.id],
      ),
    );
  }),
);

orgsRouter.get(
  '/:org/reusable/:id',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org);
    const row = await one('SELECT * FROM reusable_blocks WHERE id=? AND org_id=?', [req.params.id, org.id]);
    if (!row) throw notFound('Reusable block');
    const usage = await query(
      `SELECT DISTINCT s.id AS space_id, s.name AS space_name, p.stable_id, p.title FROM pages p JOIN spaces s ON s.id=p.space_id JOIN branches b ON b.id=p.branch_id
       WHERE s.org_id=? AND b.is_main=1 AND p.content LIKE ? LIMIT 100`,
      [org.id, `%${row.id}%`],
    );
    res.json({ ...row, content: json<PMNode>(row.content, emptyDoc()), usage });
  }),
);

const reusableSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  content: z.any().optional(),
});

orgsRouter.post(
  '/:org/reusable',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'editor');
    const body = parse(reusableSchema, req.body);
    const id = uuid();
    const content: PMNode = body.content || emptyDoc();
    await insert('reusable_blocks', { id, org_id: org.id, name: body.name || 'Untitled block', description: body.description ?? null, content, content_text: extractText(content), updated_by: req.user!.id });
    await audit(req, org.id, 'reusable.created', { type: 'reusable', id });
    res.json({ id });
  }),
);

orgsRouter.patch(
  '/:org/reusable/:id',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'editor');
    const body = parse(reusableSchema, req.body);
    const row = await one('SELECT id FROM reusable_blocks WHERE id=? AND org_id=?', [req.params.id, org.id]);
    if (!row) throw notFound('Reusable block');
    await exec(
      'UPDATE reusable_blocks SET name=COALESCE(?, name), description=?, content=COALESCE(?, content), content_text=COALESCE(?, content_text), updated_by=?, updated_at=NOW(3) WHERE id=?',
      [body.name ?? null, body.description ?? null, body.content ? JSON.stringify(body.content) : null, body.content ? extractText(body.content) : null, req.user!.id, row.id],
    );
    // Reusable content is expanded at render time: invalidate published caches of the org's spaces.
    await exec('UPDATE spaces SET content_version=content_version+1 WHERE org_id=?', [org.id]);
    res.json({ ok: true });
  }),
);

orgsRouter.delete(
  '/:org/reusable/:id',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'editor');
    await exec('DELETE FROM reusable_blocks WHERE id=? AND org_id=?', [req.params.id, org.id]);
    await exec('UPDATE spaces SET content_version=content_version+1 WHERE org_id=?', [org.id]);
    await audit(req, org.id, 'reusable.deleted', { type: 'reusable', id: req.params.id });
    res.json({ ok: true });
  }),
);

// ---- Audit log ------------------------------------------------------------------------------

orgsRouter.get(
  '/:org/audit',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const before = req.query.before ? Number(req.query.before) : null;
    const action = typeof req.query.action === 'string' && req.query.action ? req.query.action : null;
    const rows = await query(
      `SELECT a.*, u.name AS actor_name, u.email AS actor_email FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
       WHERE a.org_id=? ${before ? 'AND a.id < ?' : ''} ${action ? 'AND a.action LIKE ?' : ''} ORDER BY a.id DESC LIMIT ?`,
      [org.id, ...(before ? [before] : []), ...(action ? [`${action}%`] : []), limit],
    );
    res.json(rows.map((r) => ({ ...r, meta: json(r.meta, null) })));
  }),
);

orgsRouter.get(
  '/:org/audit.csv',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    const rows = await query(
      `SELECT a.created_at, u.email AS actor, a.action, a.target_type, a.target_id, a.ip, a.meta FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.org_id=? ORDER BY a.id DESC LIMIT 50000`,
      [org.id],
    );
    const csv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${org.slug}.csv"`);
    res.send(['time,actor,action,target_type,target_id,ip,meta', ...rows.map((r) => [new Date(r.created_at).toISOString(), r.actor, r.action, r.target_type, r.target_id, r.ip, r.meta].map(csv).join(','))].join('\n'));
  }),
);

// ---- Webhooks -------------------------------------------------------------------------------

const webhookSchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.string()).min(1),
  spaceId: z.string().max(36).nullable().optional(),
  active: z.boolean().optional(),
});

orgsRouter.get(
  '/:org/webhooks',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    const hooks = await query(
      `SELECT w.*, s.name AS space_name,
        (SELECT status FROM webhook_deliveries d WHERE d.webhook_id=w.id ORDER BY d.created_at DESC LIMIT 1) AS last_status
       FROM webhooks w LEFT JOIN spaces s ON s.id=w.space_id WHERE w.org_id=? ORDER BY w.created_at DESC`,
      [org.id],
    );
    res.json({ events: WEBHOOK_EVENTS, webhooks: hooks.map((h) => ({ ...h, events: json(h.events, []), active: !!h.active })) });
  }),
);

orgsRouter.post(
  '/:org/webhooks',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    const body = parse(webhookSchema, req.body);
    const id = uuid();
    const secret = `whsec_${randomToken(24)}`;
    await insert('webhooks', { id, org_id: org.id, space_id: body.spaceId || null, url: body.url, secret, events: body.events, active: body.active !== false ? 1 : 0, created_by: req.user!.id });
    await audit(req, org.id, 'webhook.created', { type: 'webhook', id }, { url: body.url });
    res.json({ id, secret });
  }),
);

orgsRouter.patch(
  '/:org/webhooks/:id',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    const body = parse(webhookSchema.partial(), req.body);
    await exec('UPDATE webhooks SET url=COALESCE(?, url), events=COALESCE(?, events), active=COALESCE(?, active), space_id=? WHERE id=? AND org_id=?', [
      body.url ?? null,
      body.events ? JSON.stringify(body.events) : null,
      body.active === undefined ? null : body.active ? 1 : 0,
      body.spaceId ?? null,
      req.params.id,
      org.id,
    ]);
    await audit(req, org.id, 'webhook.updated', { type: 'webhook', id: req.params.id });
    res.json({ ok: true });
  }),
);

orgsRouter.delete(
  '/:org/webhooks/:id',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    await exec('DELETE FROM webhooks WHERE id=? AND org_id=?', [req.params.id, org.id]);
    await audit(req, org.id, 'webhook.deleted', { type: 'webhook', id: req.params.id });
    res.json({ ok: true });
  }),
);

orgsRouter.get(
  '/:org/webhooks/:id/deliveries',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    const hook = await one('SELECT id FROM webhooks WHERE id=? AND org_id=?', [req.params.id, org.id]);
    if (!hook) throw notFound('Webhook');
    const rows = await query('SELECT id, event, status, attempts, response_code, response_body, payload, created_at, updated_at FROM webhook_deliveries WHERE webhook_id=? ORDER BY created_at DESC LIMIT 50', [hook.id]);
    res.json(rows.map((r) => ({ ...r, payload: json(r.payload, null) })));
  }),
);

orgsRouter.post(
  '/:org/webhooks/:id/test',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    const hook = await one('SELECT * FROM webhooks WHERE id=? AND org_id=?', [req.params.id, org.id]);
    if (!hook) throw notFound('Webhook');
    const delivery = { id: uuid(), event: 'ping', payload: { event: 'ping', createdAt: new Date().toISOString(), orgId: org.id, data: { message: 'Hello from DocSpace' } } };
    const result = await deliver(delivery, hook);
    await insert('webhook_deliveries', { id: delivery.id, webhook_id: hook.id, event: 'ping', payload: delivery.payload, status: result.ok ? 'success' : 'failed', attempts: 1, response_code: result.code, response_body: result.body });
    res.json(result);
  }),
);

orgsRouter.post(
  '/:org/webhooks/:id/deliveries/:deliveryId/retry',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org, 'admin');
    await exec(
      `UPDATE webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id SET d.status='pending', d.next_attempt_at=NOW(3), d.attempts=0 WHERE d.id=? AND w.org_id=?`,
      [req.params.deliveryId, org.id],
    );
    res.json({ ok: true });
  }),
);

// ---- Org-wide search across spaces the user can access (editor-side) -------------------------

orgsRouter.get(
  '/:org/search',
  ah(async (req, res) => {
    const { org } = await requireOrg(req, req.params.org);
    const q = String(req.query.q || '').trim();
    if (!q) return void res.json([]);
    const rows = await query(
      `SELECT p.id AS page_id, p.stable_id, p.title, p.space_id, s.name AS space_name, b.id AS branch_id, LEFT(p.content_text, 300) AS excerpt, s.settings, s.org_id,
         MATCH(p.title, p.content_text) AGAINST (? IN NATURAL LANGUAGE MODE) AS score
       FROM pages p JOIN branches b ON b.id=p.branch_id JOIN spaces s ON s.id=p.space_id
       WHERE s.org_id=? AND b.is_main=1 AND p.deleted=0 AND (MATCH(p.title, p.content_text) AGAINST (? IN NATURAL LANGUAGE MODE) OR p.title LIKE ?)
       ORDER BY score DESC LIMIT 30`,
      [q, org.id, q, `%${q}%`],
    );
    const out = [];
    const roleCache = new Map<string, boolean>();
    for (const r of rows) {
      if (!roleCache.has(r.space_id)) {
        const role = await getSpaceRole(req.user!.id, req.user!.is_admin, { id: r.space_id, org_id: r.org_id, settings: r.settings });
        roleCache.set(r.space_id, atLeast(role, 'reader'));
      }
      if (roleCache.get(r.space_id)) out.push({ pageId: r.page_id, stableId: r.stable_id, title: r.title, spaceId: r.space_id, spaceName: r.space_name, branchId: r.branch_id, excerpt: r.excerpt });
    }
    res.json(out);
  }),
);
