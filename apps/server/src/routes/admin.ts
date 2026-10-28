import { Router } from 'express';
import { z } from 'zod';
import { exec, one, pingDb, query, json } from '../db.js';
import { requireInstanceAdmin, hashPassword, validatePasswordStrength } from '../auth/session.js';
import { cache } from '../redis.js';
import { storage } from '../storage.js';
import { collabStats } from '../collab.js';
import { aiInfo } from '../ai/provider.js';
import { audit } from '../audit.js';
import { ah, badRequest, notFound, parse } from '../util.js';
import { config } from '../config.js';

export const adminRouter = Router();
adminRouter.use(requireInstanceAdmin);

adminRouter.get(
  '/stats',
  ah(async (_req, res) => {
    const counts = await one(
      `SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM organizations) AS orgs, (SELECT COUNT(*) FROM spaces) AS spaces,
        (SELECT COUNT(*) FROM spaces WHERE published=1) AS published_spaces,
        (SELECT COUNT(*) FROM pages p JOIN branches b ON b.id=p.branch_id WHERE b.is_main=1 AND p.deleted=0) AS pages,
        (SELECT COUNT(*) FROM files) AS files, (SELECT COALESCE(SUM(size),0) FROM files) AS file_bytes,
        (SELECT COUNT(*) FROM sessions WHERE expires_at > NOW(3)) AS sessions,
        (SELECT COUNT(*) FROM analytics_events WHERE created_at > DATE_SUB(NOW(3), INTERVAL 1 DAY)) AS events_24h,
        (SELECT COUNT(*) FROM webhook_deliveries WHERE status='pending') AS webhooks_pending,
        (SELECT COUNT(*) FROM webhook_deliveries WHERE status='failed') AS webhooks_failed`,
    );
    res.json({
      counts: Object.fromEntries(Object.entries(counts || {}).map(([k, v]) => [k, Number(v)])),
      health: { database: await pingDb(), cache: { kind: cache.kind, ok: await cache.ping() }, storage: { kind: storage.kind, ok: await storage.ping().catch(() => false) } },
      collab: collabStats(),
      ai: aiInfo(),
      runtime: { node: process.version, uptimeSec: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576), env: config.env, appUrl: config.appUrl, allowRegistration: config.allowRegistration },
    });
  }),
);

adminRouter.get(
  '/users',
  ah(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const rows = await query(
      `SELECT u.id, u.email, u.name, u.is_admin, u.disabled, u.totp_enabled, u.created_at, u.last_login_at,
        (SELECT COUNT(*) FROM org_members m WHERE m.user_id=u.id) AS orgs
       FROM users u ${q ? 'WHERE u.email LIKE ? OR u.name LIKE ?' : ''} ORDER BY u.created_at DESC LIMIT 200`,
      q ? [`%${q}%`, `%${q}%`] : [],
    );
    res.json(rows.map((r) => ({ ...r, is_admin: !!r.is_admin, disabled: !!r.disabled, totp_enabled: !!r.totp_enabled })));
  }),
);

adminRouter.patch(
  '/users/:id',
  ah(async (req, res) => {
    const body = parse(z.object({ is_admin: z.boolean().optional(), disabled: z.boolean().optional(), password: z.string().max(200).optional(), reset2fa: z.boolean().optional() }), req.body);
    const user = await one('SELECT id FROM users WHERE id=?', [req.params.id]);
    if (!user) throw notFound('User');
    if (req.params.id === req.user!.id && (body.is_admin === false || body.disabled)) throw badRequest('You cannot remove your own admin access or disable yourself');
    if (body.is_admin !== undefined) await exec('UPDATE users SET is_admin=? WHERE id=?', [body.is_admin ? 1 : 0, user.id]);
    if (body.disabled !== undefined) {
      await exec('UPDATE users SET disabled=? WHERE id=?', [body.disabled ? 1 : 0, user.id]);
      if (body.disabled) await exec('DELETE FROM sessions WHERE user_id=?', [user.id]);
    }
    if (body.password) {
      const err = validatePasswordStrength(body.password);
      if (err) throw badRequest(err);
      await exec('UPDATE users SET password_hash=? WHERE id=?', [await hashPassword(body.password), user.id]);
      await exec('DELETE FROM sessions WHERE user_id=?', [user.id]);
    }
    if (body.reset2fa) await exec('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?', [user.id]);
    await audit(req, null, 'admin.user_updated', { type: 'user', id: user.id }, { ...body, password: body.password ? '***' : undefined });
    res.json({ ok: true });
  }),
);

adminRouter.delete(
  '/users/:id/sessions',
  ah(async (req, res) => {
    await exec('DELETE FROM sessions WHERE user_id=?', [req.params.id]);
    await audit(req, null, 'admin.sessions_revoked', { type: 'user', id: req.params.id });
    res.json({ ok: true });
  }),
);

adminRouter.get(
  '/orgs',
  ah(async (_req, res) => {
    res.json(
      await query(
        `SELECT o.id, o.name, o.slug, o.created_at, (SELECT COUNT(*) FROM org_members m WHERE m.org_id=o.id) AS members,
          (SELECT COUNT(*) FROM spaces s WHERE s.org_id=o.id) AS spaces FROM organizations o ORDER BY o.created_at DESC LIMIT 500`,
      ),
    );
  }),
);

adminRouter.get(
  '/audit',
  ah(async (req, res) => {
    const before = req.query.before ? Number(req.query.before) : null;
    const rows = await query(
      `SELECT a.*, u.email AS actor_email, o.name AS org_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN organizations o ON o.id=a.org_id
       ${before ? 'WHERE a.id < ?' : ''} ORDER BY a.id DESC LIMIT 100`,
      before ? [before] : [],
    );
    res.json(rows.map((r) => ({ ...r, meta: json(r.meta, null) })));
  }),
);

adminRouter.post(
  '/maintenance/prune',
  ah(async (req, res) => {
    const days = Math.max(30, Number(req.body?.analyticsDays) || 365);
    const a = await exec('DELETE FROM analytics_events WHERE created_at < DATE_SUB(NOW(3), INTERVAL ? DAY)', [days]);
    const s = await exec('DELETE FROM sessions WHERE expires_at < NOW(3)');
    const w = await exec("DELETE FROM webhook_deliveries WHERE created_at < DATE_SUB(NOW(3), INTERVAL 30 DAY) AND status IN ('success','failed')");
    const v = await exec(
      `DELETE pv FROM page_versions pv JOIN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY created_at DESC) AS rn FROM page_versions) x WHERE x.rn > 200) old ON old.id=pv.id`,
    );
    await audit(req, null, 'admin.pruned', undefined, { analyticsDays: days });
    res.json({ analytics: a.affectedRows, sessions: s.affectedRows, deliveries: w.affectedRows, versions: v.affectedRows });
  }),
);
