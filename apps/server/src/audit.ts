import type { Request } from 'express';
import { insert } from './db.js';
import { logger } from './logger.js';
import { clientIp } from './util.js';

export async function audit(
  req: Request | null,
  orgId: string | null,
  action: string,
  target?: { type: string; id: string },
  meta?: Record<string, unknown>,
) {
  try {
    await insert('audit_logs', {
      org_id: orgId,
      actor_id: req?.user?.id ?? null,
      action,
      target_type: target?.type ?? null,
      target_id: target?.id ?? null,
      meta: meta ?? null,
      ip: req ? clientIp(req) : null,
    });
  } catch (err) {
    logger.error('audit log failed', { error: (err as Error).message, action });
  }
}
