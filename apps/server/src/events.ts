import { exec, insert, json, pool, query } from './db.js';
import { logger } from './logger.js';
import { hmac, uuid } from './util.js';

export const WEBHOOK_EVENTS = [
  'space.created',
  'space.updated',
  'space.deleted',
  'space.published',
  'page.created',
  'page.updated',
  'page.deleted',
  'change_request.created',
  'change_request.updated',
  'change_request.merged',
  'change_request.closed',
  'review.submitted',
  'comment.created',
  'member.added',
  'member.removed',
  'feedback.received',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Queue webhook deliveries for an event. Delivery happens in the background worker. */
export async function emit(event: WebhookEvent, ctx: { orgId: string; spaceId?: string | null }, data: Record<string, unknown>) {
  try {
    const hooks = await query(
      `SELECT * FROM webhooks WHERE org_id=? AND active=1 AND (space_id IS NULL OR space_id=?)`,
      [ctx.orgId, ctx.spaceId ?? null],
    );
    for (const hook of hooks) {
      const events = json<string[]>(hook.events, []);
      if (!events.includes('*') && !events.includes(event)) continue;
      await insert('webhook_deliveries', {
        id: uuid(),
        webhook_id: hook.id,
        event,
        payload: { id: uuid(), event, createdAt: new Date().toISOString(), orgId: ctx.orgId, spaceId: ctx.spaceId ?? null, data },
      });
    }
  } catch (err) {
    logger.error('emit failed', { event, error: (err as Error).message });
  }
}

export async function notify(userIds: string[], n: { type: string; title: string; body?: string; link?: string }) {
  for (const userId of new Set(userIds)) {
    await insert('notifications', { id: uuid(), user_id: userId, type: n.type, title: n.title, body: n.body ?? null, link: n.link ?? null });
  }
}

const MAX_ATTEMPTS = 6;

export async function deliver(delivery: any, hook: any): Promise<{ ok: boolean; code: number | null; body: string }> {
  const body = typeof delivery.payload === 'string' ? delivery.payload : JSON.stringify(delivery.payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'DocSpace-Webhooks/1.0',
        'x-docspace-event': delivery.event,
        'x-docspace-delivery': delivery.id,
        'x-docspace-timestamp': ts,
        'x-docspace-signature': `sha256=${hmac(hook.secret, `${ts}.${body}`)}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const text = (await res.text()).slice(0, 2000);
    return { ok: res.ok, code: res.status, body: text };
  } catch (err) {
    return { ok: false, code: null, body: (err as Error).message };
  }
}

async function processBatch() {
  const conn = await pool.getConnection();
  let claimed: any[] = [];
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT d.*, w.url, w.secret FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id
       WHERE d.status='pending' AND d.next_attempt_at <= NOW(3) ORDER BY d.next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED`,
    );
    claimed = rows as any[];
    if (claimed.length) {
      await conn.query(`UPDATE webhook_deliveries SET status='sending', updated_at=NOW(3) WHERE id IN (?)`, [claimed.map((d) => d.id)]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  await Promise.all(
    claimed.map(async (d) => {
      const result = await deliver(d, { url: d.url, secret: d.secret });
      const attempts = d.attempts + 1;
      const status = result.ok ? 'success' : attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      const backoff = Math.min(3600, 15 * 2 ** attempts);
      await exec(
        `UPDATE webhook_deliveries SET status=?, attempts=?, response_code=?, response_body=?, updated_at=NOW(3),
         next_attempt_at=DATE_ADD(NOW(3), INTERVAL ? SECOND) WHERE id=?`,
        [status, attempts, result.code, result.body, backoff, d.id],
      );
    }),
  );
}

export function startWebhookWorker() {
  // Recover deliveries stuck in "sending" after a crash.
  void exec(`UPDATE webhook_deliveries SET status='pending' WHERE status='sending' AND updated_at < DATE_SUB(NOW(3), INTERVAL 5 MINUTE)`).catch(() => {});
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processBatch();
    } catch (err) {
      logger.warn('webhook worker error', { error: (err as Error).message });
    } finally {
      running = false;
    }
  }, 3000).unref();
}
