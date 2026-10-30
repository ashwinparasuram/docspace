import { Router } from 'express';
import { z } from 'zod';
import otplib from 'otplib';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { exec, insert, one, query, tx, json } from '../db.js';
import {
  createSession,
  destroySession,
  hashPassword,
  rateLimit,
  requireAuth,
  validatePasswordStrength,
  verifyPassword,
} from '../auth/session.js';
import { audit } from '../audit.js';
import { emit } from '../events.js';
import { aiInfo } from '../ai/provider.js';
import { ah, badRequest, HttpError, parse, randomToken, sha256, slugify, uuid } from '../util.js';
import type { OrgSettings } from '../permissions.js';

const { authenticator } = otplib;
authenticator.options = { window: 1 };

export const authRouter = Router();

authRouter.get(
  '/meta',
  ah(async (_req, res) => {
    const users = await one<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    res.json({
      needsSetup: (users?.n ?? 0) === 0,
      allowRegistration: config.allowRegistration || (users?.n ?? 0) === 0,
      appUrl: config.appUrl,
      ai: aiInfo(),
      version: '1.0.0',
    });
  }),
);

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(8).max(200),
  orgName: z.string().trim().max(120).optional(),
  inviteToken: z.string().max(100).optional(),
});

authRouter.post(
  '/register',
  rateLimit('register', 10, 3600),
  ah(async (req, res) => {
    const body = parse(registerSchema, req.body);
    const users = await one<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    const firstUser = (users?.n ?? 0) === 0;
    const invite = body.inviteToken
      ? await one('SELECT * FROM invitations WHERE token=? AND accepted_at IS NULL AND expires_at > NOW(3)', [body.inviteToken])
      : null;
    if (!firstUser && !config.allowRegistration && !invite) throw new HttpError(403, 'Registration is disabled on this instance. Ask an administrator for an invitation.');
    const pwErr = validatePasswordStrength(body.password);
    if (pwErr) throw badRequest(pwErr);
    if (await one('SELECT id FROM users WHERE email=?', [body.email])) throw badRequest('An account with this email already exists');
    const userId = uuid();
    await tx(async (conn) => {
      await insert('users', { id: userId, email: body.email, name: body.name, password_hash: await hashPassword(body.password), is_admin: firstUser ? 1 : 0 }, conn);
      if (invite) {
        await insert('org_members', { org_id: invite.org_id, user_id: userId, role: invite.role }, conn);
        await exec('UPDATE invitations SET accepted_at=NOW(3), accepted_by=? WHERE id=?', [userId, invite.id], conn);
      } else {
        const orgName = body.orgName || `${body.name.split(' ')[0]}'s workspace`;
        const orgId = uuid();
        let slug = slugify(orgName);
        if (await one('SELECT id FROM organizations WHERE slug=?', [slug], conn)) slug = `${slug}-${userId.slice(0, 6)}`;
        await insert('organizations', { id: orgId, name: orgName, slug, settings: {} }, conn);
        await insert('org_members', { org_id: orgId, user_id: userId, role: 'owner' }, conn);
      }
    });
    await createSession(req, res, userId);
    await audit(req, invite?.org_id ?? null, 'user.registered', { type: 'user', id: userId });
    if (invite) void emit('member.added', { orgId: invite.org_id }, { userId, role: invite.role });
    res.json({ ok: true });
  }),
);

// Accepts an email or a plain username such as the seeded "admin" account.
const loginSchema = z.object({ email: z.string().trim().toLowerCase().min(1).max(255), password: z.string().min(1).max(200) });

authRouter.post(
  '/login',
  rateLimit('login', 20, 900),
  ah(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const user = await one('SELECT * FROM users WHERE email=?', [body.email]);
    if (!user || user.disabled || !(await verifyPassword(body.password, user.password_hash))) {
      await audit(req, null, 'auth.login_failed', undefined, { email: body.email });
      throw new HttpError(401, 'Invalid email or password');
    }
    await createSession(req, res, user.id, !!user.totp_enabled);
    if (!user.totp_enabled) {
      await exec('UPDATE users SET last_login_at=NOW(3) WHERE id=?', [user.id]);
      await audit(req, null, 'auth.login', { type: 'user', id: user.id });
    }
    res.json({ ok: true, mfaRequired: !!user.totp_enabled });
  }),
);

authRouter.post(
  '/mfa',
  rateLimit('mfa', 10, 300),
  ah(async (req, res) => {
    if (!req.user || !req.mfaPending || !req.sessionId) throw new HttpError(401, 'No pending sign-in');
    const code = String(req.body?.code || '').replace(/\s/g, '');
    const user = await one('SELECT totp_secret FROM users WHERE id=?', [req.user.id]);
    if (!user?.totp_secret || !authenticator.check(code, user.totp_secret)) throw new HttpError(401, 'Invalid authentication code');
    await exec('UPDATE sessions SET mfa_pending=0 WHERE id=?', [req.sessionId]);
    await exec('UPDATE users SET last_login_at=NOW(3) WHERE id=?', [req.user.id]);
    await audit(req, null, 'auth.login', { type: 'user', id: req.user.id }, { mfa: true });
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/logout',
  ah(async (req, res) => {
    await destroySession(res, req.sessionId);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  ah(async (req, res) => {
    if (!req.user) return void res.json({ user: null });
    if (req.mfaPending) return void res.json({ user: null, mfaPending: true });
    const orgs = await query(
      `SELECT o.id, o.name, o.slug, o.logo_url, o.settings, m.role FROM org_members m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=? ORDER BY o.name`,
      [req.user.id],
    );
    const unread = await one<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL', [req.user.id]);
    res.json({
      user: req.user,
      orgs: orgs.map((o) => ({ ...o, settings: undefined, enforce2fa: !!json<OrgSettings>(o.settings, {}).enforce2fa })),
      unreadNotifications: unread?.n ?? 0,
    });
  }),
);

authRouter.patch(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(120).optional(), avatar_url: z.string().max(1024).nullable().optional() }), req.body);
    await exec('UPDATE users SET name=COALESCE(?, name), avatar_url=? WHERE id=?', [body.name ?? null, body.avatar_url ?? req.user!.avatar_url, req.user!.id]);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/password',
  requireAuth,
  rateLimit('password', 10, 900),
  ah(async (req, res) => {
    const body = parse(z.object({ current: z.string().max(200), next: z.string().min(8).max(200) }), req.body);
    const user = await one('SELECT password_hash FROM users WHERE id=?', [req.user!.id]);
    if (!(await verifyPassword(body.current, user?.password_hash))) throw badRequest('Current password is incorrect');
    const err = validatePasswordStrength(body.next);
    if (err) throw badRequest(err);
    await exec('UPDATE users SET password_hash=? WHERE id=?', [await hashPassword(body.next), req.user!.id]);
    await exec('DELETE FROM sessions WHERE user_id=? AND id<>?', [req.user!.id, req.sessionId ?? '']);
    await audit(req, null, 'auth.password_changed', { type: 'user', id: req.user!.id });
    res.json({ ok: true });
  }),
);

// ---- Two-factor authentication (TOTP) ---------------------------------------------------------

authRouter.post(
  '/2fa/setup',
  requireAuth,
  ah(async (req, res) => {
    const secret = authenticator.generateSecret();
    await exec('UPDATE users SET totp_secret=? WHERE id=? AND totp_enabled=0', [secret, req.user!.id]);
    const uri = authenticator.keyuri(req.user!.email, 'DocSpace', secret);
    res.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
  }),
);

authRouter.post(
  '/2fa/enable',
  requireAuth,
  ah(async (req, res) => {
    const code = String(req.body?.code || '').replace(/\s/g, '');
    const user = await one('SELECT totp_secret FROM users WHERE id=?', [req.user!.id]);
    if (!user?.totp_secret || !authenticator.check(code, user.totp_secret)) throw badRequest('Invalid code — check your authenticator app');
    await exec('UPDATE users SET totp_enabled=1 WHERE id=?', [req.user!.id]);
    await audit(req, null, 'auth.2fa_enabled', { type: 'user', id: req.user!.id });
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/2fa/disable',
  requireAuth,
  ah(async (req, res) => {
    const body = parse(z.object({ password: z.string().max(200) }), req.body);
    const user = await one('SELECT password_hash FROM users WHERE id=?', [req.user!.id]);
    if (!(await verifyPassword(body.password, user?.password_hash))) throw badRequest('Password is incorrect');
    await exec('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?', [req.user!.id]);
    await audit(req, null, 'auth.2fa_disabled', { type: 'user', id: req.user!.id });
    res.json({ ok: true });
  }),
);

// ---- Sessions & API tokens ----------------------------------------------------------------------

authRouter.get(
  '/sessions',
  requireAuth,
  ah(async (req, res) => {
    const rows = await query('SELECT id, ip, user_agent, created_at, last_seen_at FROM sessions WHERE user_id=? AND expires_at > NOW(3) ORDER BY last_seen_at DESC', [req.user!.id]);
    res.json(rows.map((r) => ({ ...r, current: r.id === req.sessionId })));
  }),
);

authRouter.delete(
  '/sessions/:id',
  requireAuth,
  ah(async (req, res) => {
    await exec('DELETE FROM sessions WHERE id=? AND user_id=?', [req.params.id, req.user!.id]);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/tokens',
  requireAuth,
  ah(async (req, res) => {
    res.json(await query('SELECT id, name, prefix, last_used_at, expires_at, created_at FROM api_tokens WHERE user_id=? ORDER BY created_at DESC', [req.user!.id]));
  }),
);

authRouter.post(
  '/tokens',
  requireAuth,
  ah(async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(100), expiresInDays: z.number().int().min(1).max(3650).nullable().optional() }), req.body);
    const token = `dsk_${randomToken(30)}`;
    const id = uuid();
    await insert('api_tokens', {
      id,
      user_id: req.user!.id,
      name: body.name,
      token_hash: sha256(token),
      prefix: token.slice(0, 10),
      expires_at: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400_000) : null,
    });
    await audit(req, null, 'auth.token_created', { type: 'api_token', id }, { name: body.name });
    res.json({ id, token });
  }),
);

authRouter.delete(
  '/tokens/:id',
  requireAuth,
  ah(async (req, res) => {
    await exec('DELETE FROM api_tokens WHERE id=? AND user_id=?', [req.params.id, req.user!.id]);
    res.json({ ok: true });
  }),
);

// ---- Invitations ------------------------------------------------------------------------------

authRouter.get(
  '/invitations/:token',
  ah(async (req, res) => {
    const inv = await one(
      `SELECT i.role, i.email, i.expires_at, i.accepted_at, o.name AS org_name, o.slug AS org_slug FROM invitations i JOIN organizations o ON o.id=i.org_id WHERE i.token=?`,
      [req.params.token],
    );
    if (!inv || inv.accepted_at || new Date(inv.expires_at) < new Date()) throw new HttpError(404, 'This invitation is invalid or has expired');
    res.json(inv);
  }),
);

authRouter.post(
  '/invitations/:token/accept',
  requireAuth,
  ah(async (req, res) => {
    const inv = await one('SELECT * FROM invitations WHERE token=? AND accepted_at IS NULL AND expires_at > NOW(3)', [req.params.token]);
    if (!inv) throw new HttpError(404, 'This invitation is invalid or has expired');
    if (inv.email && inv.email.toLowerCase() !== req.user!.email.toLowerCase()) throw new HttpError(403, `This invitation was sent to ${inv.email}`);
    const existing = await one('SELECT role FROM org_members WHERE org_id=? AND user_id=?', [inv.org_id, req.user!.id]);
    if (!existing) await insert('org_members', { org_id: inv.org_id, user_id: req.user!.id, role: inv.role });
    await exec('UPDATE invitations SET accepted_at=NOW(3), accepted_by=? WHERE id=?', [req.user!.id, inv.id]);
    await audit(req, inv.org_id, 'member.joined', { type: 'user', id: req.user!.id }, { role: inv.role });
    void emit('member.added', { orgId: inv.org_id }, { userId: req.user!.id, role: inv.role });
    const org = await one('SELECT slug FROM organizations WHERE id=?', [inv.org_id]);
    res.json({ ok: true, orgSlug: org?.slug });
  }),
);

// ---- Notifications ----------------------------------------------------------------------------

authRouter.get(
  '/notifications',
  requireAuth,
  ah(async (req, res) => {
    res.json(await query('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50', [req.user!.id]));
  }),
);

authRouter.post(
  '/notifications/read',
  requireAuth,
  ah(async (req, res) => {
    await exec('UPDATE notifications SET read_at=NOW(3) WHERE user_id=? AND read_at IS NULL', [req.user!.id]);
    res.json({ ok: true });
  }),
);
