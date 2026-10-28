import { Redis } from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Cache + pub/sub abstraction. Uses Redis when REDIS_URL is set (required for multi-node
 * deployments), otherwise an in-process implementation so a single machine needs nothing extra.
 */
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  incr(key: string, ttlSeconds: number): Promise<number>;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  ping(): Promise<boolean>;
  readonly kind: 'redis' | 'memory';
}

class MemoryCache implements Cache {
  kind = 'memory' as const;
  private store = new Map<string, { value: string; expires: number }>();
  private handlers = new Map<string, Set<(m: string) => void>>();

  constructor() {
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.store) if (v.expires && v.expires < now) this.store.delete(k);
    }, 60_000).unref();
  }

  async get(key: string) {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expires && e.expires < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }
  async set(key: string, value: string, ttl?: number) {
    if (this.store.size > 20_000) this.store.delete(this.store.keys().next().value as string);
    this.store.set(key, { value, expires: ttl ? Date.now() + ttl * 1000 : 0 });
  }
  async del(...keys: string[]) {
    for (const k of keys) this.store.delete(k);
  }
  async incr(key: string, ttl: number) {
    const cur = Number((await this.get(key)) ?? 0) + 1;
    const existing = this.store.get(key);
    this.store.set(key, { value: String(cur), expires: existing?.expires || Date.now() + ttl * 1000 });
    return cur;
  }
  async publish(channel: string, message: string) {
    // Local subscribers are on this node and already handled the event directly.
    void channel;
    void message;
  }
  async subscribe(channel: string, handler: (m: string) => void) {
    if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
    this.handlers.get(channel)!.add(handler);
  }
  async ping() {
    return true;
  }
}

class RedisCache implements Cache {
  kind = 'redis' as const;
  private client: Redis;
  private sub: Redis;
  private handlers = new Map<string, Set<(m: string) => void>>();

  constructor(url: string) {
    this.client = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
    this.sub = new Redis(url, { maxRetriesPerRequest: null });
    this.client.on('error', (e: Error) => logger.warn('redis error', { error: e.message }));
    this.sub.on('error', (e: Error) => logger.warn('redis sub error', { error: e.message }));
    this.sub.on('message', (channel: string, message: string) => {
      this.handlers.get(channel)?.forEach((h) => h(message));
    });
  }
  async get(key: string) {
    return this.client.get(key);
  }
  async set(key: string, value: string, ttl?: number) {
    if (ttl) await this.client.set(key, value, 'EX', ttl);
    else await this.client.set(key, value);
  }
  async del(...keys: string[]) {
    if (keys.length) await this.client.del(...keys);
  }
  async incr(key: string, ttl: number) {
    const n = await this.client.incr(key);
    if (n === 1) await this.client.expire(key, ttl);
    return n;
  }
  async publish(channel: string, message: string) {
    await this.client.publish(channel, message);
  }
  async subscribe(channel: string, handler: (m: string) => void) {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      await this.sub.subscribe(channel);
    }
    this.handlers.get(channel)!.add(handler);
  }
  async ping() {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}

export const cache: Cache = config.redisUrl ? new RedisCache(config.redisUrl) : new MemoryCache();
