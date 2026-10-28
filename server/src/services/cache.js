import Redis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const PREFIX = 'vendora:';

/**
 * Minimal in-process stand-in for Redis, used when REDIS_URL is not configured.
 * Implements only the commands the app uses, with the same semantics (string values + TTL).
 */
class MemoryStore {
  constructor() {
    this.map = new Map();
  }

  #entry(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return entry;
  }

  async get(key) {
    return this.#entry(key)?.value ?? null;
  }

  async set(key, value, mode, seconds) {
    const expiresAt = mode === 'EX' ? Date.now() + seconds * 1000 : null;
    this.map.set(key, { value: String(value), expiresAt });
    return 'OK';
  }

  async del(...keys) {
    return keys.flat().reduce((count, key) => count + (this.map.delete(key) ? 1 : 0), 0);
  }

  async exists(key) {
    return this.#entry(key) ? 1 : 0;
  }

  async incr(key) {
    const entry = this.#entry(key);
    const next = (Number(entry?.value) || 0) + 1;
    this.map.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
    return next;
  }

  async expire(key, seconds) {
    const entry = this.#entry(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async keys(pattern) {
    const regex = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return [...this.map.keys()].filter((key) => regex.test(key) && this.#entry(key));
  }

  async ping() {
    return 'PONG';
  }
}

let client = new MemoryStore();
let driver = 'memory';

export async function initCache() {
  if (!env.redisUrl) {
    logger.warn('Redis: REDIS_URL not set -> using in-memory cache (set REDIS_URL to use Redis)');
    return driver;
  }
  const redis = new Redis(env.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  redis.on('error', (err) => logger.warn(`Redis error: ${err.message}`));
  try {
    await redis.connect();
    await redis.ping();
    client = redis;
    driver = 'redis';
    logger.ok('Redis connected');
  } catch (err) {
    redis.disconnect();
    logger.warn(`Redis unavailable (${err.message}) -> falling back to in-memory cache`);
  }
  return driver;
}

const k = (key) => `${PREFIX}${key}`;

/** Cache calls never break a request: on failure they log and behave like a cache miss. */
const safe = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`Cache operation failed: ${err.message}`);
    return fallback;
  }
};

export const cache = {
  get driver() {
    return driver;
  },

  async getJSON(key) {
    return safe(async () => {
      const raw = await client.get(k(key));
      return raw === null ? null : JSON.parse(raw);
    });
  },

  async setJSON(key, value, ttlSeconds = 300) {
    return safe(() => client.set(k(key), JSON.stringify(value), 'EX', ttlSeconds));
  },

  async set(key, value, ttlSeconds) {
    return safe(() => client.set(k(key), String(value), 'EX', ttlSeconds));
  },

  async exists(key) {
    return safe(async () => (await client.exists(k(key))) === 1, false);
  },

  async del(...keys) {
    const list = keys.flat().filter(Boolean);
    if (!list.length) return 0;
    return safe(() => client.del(...list.map(k)), 0);
  },

  /** Deletes every key matching a glob pattern (uses SCAN on Redis so it never blocks the server). */
  async delPattern(pattern) {
    return safe(async () => {
      const full = k(pattern);
      if (driver === 'memory') return client.del(...(await client.keys(full)));
      let cursor = '0';
      let removed = 0;
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', full, 'COUNT', 200);
        cursor = next;
        if (keys.length) removed += await client.del(...keys);
      } while (cursor !== '0');
      return removed;
    }, 0);
  },

  /** Fixed-window counter, used for lightweight rate limiting / metrics. */
  async incrWithTtl(key, ttlSeconds) {
    return safe(async () => {
      const value = await client.incr(k(key));
      if (value === 1) await client.expire(k(key), ttlSeconds);
      return value;
    }, 0);
  },

  /** Cache-aside helper: returns the cached value or computes, stores and returns it. */
  async remember(key, ttlSeconds, compute) {
    const hit = await this.getJSON(key);
    if (hit !== null) return hit;
    const value = await compute();
    if (value !== null && value !== undefined) await this.setJSON(key, value, ttlSeconds);
    return value;
  },

  async ping() {
    return safe(() => client.ping(), null);
  },
};
