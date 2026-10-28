import type { Request } from 'express';
import { json, one, query } from './db.js';
import { HttpError, clientIp, forbidden, notFound } from './util.js';

/**
 * Role ladder (lowest -> highest). Space roles and org roles share it.
 * reader: view content · commenter: + comment · reviewer: + approve change requests
 * editor: + edit content/branches · creator: + create spaces · admin: + manage settings/members
 * owner: org owner (billing-free equivalent of admin that cannot be removed by admins)
 */
export const ROLES = ['reader', 'commenter', 'reviewer', 'editor', 'creator', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export const rank = (r: string | null | undefined) => (r ? ROLES.indexOf(r as Role) : -1);
export const atLeast = (r: string | null | undefined, min: Role) => rank(r) >= rank(min);
export const maxRole = (...rs: (string | null | undefined)[]): Role | null => {
  let best: Role | null = null;
  for (const r of rs) if (r && rank(r) > rank(best)) best = r as Role;
  return best;
};

export interface OrgSettings {
  enforce2fa?: boolean;
  ipAllowlist?: string[];
  allowedEmailDomains?: string[];
  defaultSpaceRole?: Role;
}

export interface SpaceSettings {
  requireChangeRequests?: boolean;
  requireApprovals?: number;
  inheritOrgPermissions?: boolean;
  aiEnabled?: boolean;
  feedbackEnabled?: boolean;
  searchEnabled?: boolean;
  llmsTxt?: boolean;
}

export async function getOrgRole(userId: string, orgId: string): Promise<Role | null> {
  const row = await one<{ role: Role }>('SELECT role FROM org_members WHERE org_id=? AND user_id=?', [orgId, userId]);
  return row?.role ?? null;
}

function ipMatches(ip: string, rule: string): boolean {
  rule = rule.trim();
  if (!rule) return false;
  if (!rule.includes('/')) return ip === rule;
  const [base, bitsStr] = rule.split('/');
  const bits = Number(bitsStr);
  const toInt = (a: string) => a.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(base)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

/** Enforce org-level security policies (2FA, IP allowlist) for an authenticated request. */
export function enforceOrgPolicies(req: Request, org: { settings: unknown }) {
  const settings = json<OrgSettings>(org.settings, {});
  if (settings.enforce2fa && req.user && !req.user.totp_enabled && req.authVia === 'cookie') {
    throw new HttpError(403, 'This organization requires two-factor authentication. Enable it in your account settings.', {
      code: 'MFA_REQUIRED',
    });
  }
  const allow = (settings.ipAllowlist || []).filter(Boolean);
  if (allow.length) {
    const ip = clientIp(req);
    if (!allow.some((rule) => ipMatches(ip, rule)) && !['127.0.0.1', '::1'].includes(ip)) {
      throw new HttpError(403, 'Access from your IP address is not allowed by this organization', { code: 'IP_BLOCKED' });
    }
  }
}

export async function requireOrg(req: Request, orgIdOrSlug: string, min: Role = 'reader') {
  const org = await one('SELECT * FROM organizations WHERE id=? OR slug=?', [orgIdOrSlug, orgIdOrSlug]);
  if (!org) throw notFound('Organization');
  const user = req.user!;
  let role = await getOrgRole(user.id, org.id);
  if (user.is_admin) role = maxRole(role, 'admin');
  if (!role) throw notFound('Organization');
  if (!user.is_admin) enforceOrgPolicies(req, org);
  if (!atLeast(role, min)) throw forbidden();
  return { org, role };
}

export async function getSpaceRole(userId: string, isInstanceAdmin: boolean, space: any): Promise<Role | null> {
  const orgRole = await getOrgRole(userId, space.org_id);
  const settings = json<SpaceSettings>(space.settings, {});
  const inherit = settings.inheritOrgPermissions !== false;
  const explicit = await query<{ role: Role }>(
    `SELECT sp.role FROM space_permissions sp WHERE sp.space_id=? AND (
       (sp.subject_type='user' AND sp.subject_id=?) OR
       (sp.subject_type='team' AND sp.subject_id IN (SELECT tm.team_id FROM team_members tm WHERE tm.user_id=?))
     )`,
    [space.id, userId, userId],
  );
  let role: Role | null = maxRole(...explicit.map((e) => e.role));
  if (orgRole) {
    if (atLeast(orgRole, 'admin')) role = maxRole(role, 'admin');
    else if (inherit) role = maxRole(role, orgRole === 'creator' ? 'editor' : orgRole);
  }
  if (isInstanceAdmin) role = maxRole(role, 'admin');
  // Space-level roles never exceed admin.
  return role === 'owner' ? 'admin' : role;
}

export async function requireSpace(req: Request, spaceId: string, min: Role = 'reader') {
  const space = await one('SELECT * FROM spaces WHERE id=?', [spaceId]);
  if (!space) throw notFound('Space');
  const user = req.user!;
  const role = await getSpaceRole(user.id, user.is_admin, space);
  if (!role) throw notFound('Space');
  if (!user.is_admin) {
    const org = await one('SELECT settings FROM organizations WHERE id=?', [space.org_id]);
    if (org) enforceOrgPolicies(req, org);
  }
  if (!atLeast(role, min)) throw forbidden();
  return { space, role };
}

/** Whether a branch may be edited directly by this role (main may be locked behind change requests). */
export function canEditBranch(space: any, branch: any, role: Role | null): boolean {
  if (!atLeast(role, 'editor')) return false;
  if (branch.status !== 'open') return false;
  if (branch.is_main) {
    const s = json<SpaceSettings>(space.settings, {});
    if (s.requireChangeRequests) return false;
  }
  return true;
}
