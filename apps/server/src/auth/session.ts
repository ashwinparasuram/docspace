import type { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { exec, insert, one } from '../db.js';
import { cache } from '../redis.js';
import { HttpError, ah, clientIp, randomToken, sha256, uuid } from '../util.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  is_admin: boolean;
  totp_enabled: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: string;
      authVia?: 'cookie' | 'token';
      mfaPending?: boolean;
    }
  }
}

export const SESSION_COOKIE = 'ds_session';
const SESSION_DAYS = 30;

export const hashPassword = (pw: string) => bcrypt.hash(pw, 11);
export const verifyPassword = (pw: string, hash: string | null) => (hash ? bcrypt.compare(pw, hash) : Promise.resolve(false));

export function validatePasswordStrength(pw: string): string | null {
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers';
  return null;
}

export async function createSession(req: Request, res: Response, userId: string, mfaPending = false) {
  const token = randomToken(32);
  const id = uuid();
  await insert('sessions', {
    id,
    user_id: userId,
    token_hash: sha256(token),
    ip: clientIp(req),
    user_agent: (req.headers['user-agent'] || '').slice(0, 500),
    mfa_pending: mfaPending ? 1 : 0,
    expires_at: new Date(Date.now() + SESSION_DAYS * 86400_000),
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.appUrl.startsWith('https://'),
    maxAge: SESSION_DAYS * 86400_000,
    path: '/',
  });
  return id;
}

export async function destroySession(res: Response, sessionId?: string) {
  if (sessionId) {
    await exec('DELETE FROM sessions WHERE id=?', [sessionId]);
    await cache.del(`sess:${sessionId}`);
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

function toAuthUser(row: any): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatar_url: row.avatar_url,
    is_admin: !!row.is_admin,
    totp_enabled: !!row.totp_enabled,
  };
}

/** Resolve a session cookie or API token into req.user. Never rejects; use requireAuth for that. */
export async function resolveUser(req: Request): Promise<void> {
  const authz = req.headers.authorization;
  if (authz?.startsWith('Bearer ')) {
    const token = authz.slice(7).trim();
    const row = await one(
      `SELECT u.*, t.id AS token_id FROM api_tokens t JOIN users u ON u.id=t.user_id
       WHERE t.token_hash=? AND (t.expires_at IS NULL OR t.expires_at > NOW(3)) AND u.disabled=0`,
      [sha256(token)],
    );
    if (row) {
      req.user = toAuthUser(row);
      req.authVia = 'token';
      void exec('UPDATE api_tokens SET last_used_at=NOW(3) WHERE id=?', [row.token_id]);
    }
    return;
  }
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return;
  const row = await one(
    `SELECT u.*, s.id AS session_id, s.mfa_pending, s.last_seen_at FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at > NOW(3) AND u.disabled=0`,
    [sha256(token)],
  );
  if (!row) return;
  req.sessionId = row.session_id;
  req.authVia = 'cookie';
  if (row.mfa_pending) {
    req.mfaPending = true;
    req.user = toAuthUser(row);
    return;
  }
  req.user = toAuthUser(row);
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    void exec('UPDATE sessions SET last_seen_at=NOW(3), ip=? WHERE id=?', [clientIp(req), row.session_id]);
  }
}

export const authenticate = ah(async (req, _res, next) => {
  await resolveUser(req);
  next();
});

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || req.mfaPending) return next(new HttpError(401, 'Authentication required'));
  next();
}

export function requireInstanceAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || req.mfaPending) return next(new HttpError(401, 'Authentication required'));
  if (!req.user.is_admin) return next(new HttpError(403, 'Instance administrator access required'));
  next();
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests: browsers cannot attach a custom
 * header cross-origin without a CORS preflight, which this server never grants.
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.authVia === 'token') return next();
  if (req.headers['x-requested-with'] !== 'docspace') return next(new HttpError(403, 'Missing CSRF header'));
  next();
}

export function rateLimit(name: string, max: number, windowSec: number) {
  return ah(async (req, res, next) => {
    const key = `rl:${name}:${clientIp(req)}:${Math.floor(Date.now() / 1000 / windowSec)}`;
    const n = await cache.incr(key, windowSec);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - n)));
    if (n > max) throw new HttpError(429, 'Too many requests, slow down');
    next();
  });
}
