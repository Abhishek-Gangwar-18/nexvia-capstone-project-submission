import crypto from 'node:crypto';
import Redis from 'ioredis';
import { env, isProd } from '../config/env.js';
import { ApiError } from '../utils/http.js';
import { logger } from '../utils/logger.js';

const PREFIX = 'vendora:';

/** Deletes a lock only while it still holds the caller's token, so an expired lock re-taken by someone else is left alone. */
const RELEASE_LOCK = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

/**
 * Fixed-window counter in one round trip: increments, starts the window on the first hit (or repairs a key
 * that lost its expiry) and returns [hits, ms left in the window].
 */
const HIT_WINDOW = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}`;

/**
 * Minimal in-process stand-in for Redis, used when REDIS_URL is not configured.
 * Implements only the commands the app uses, with the same semantics (string values + TTL).
 */
class MemoryStore {
  constructor() {
    this.map = new Map();
    // Rate-limit keys of one-off visitors are never read again; sweep expired entries so they don't pile up.
    setInterval(() => {
      for (const key of this.map.keys()) this.#entry(key);
    }, 60 * 1000).unref();
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

  /** set(key, value, 'EX', seconds) with an optional trailing 'NX' (only if the key is free). */
  async set(key, value, ...options) {
    if (options.includes('NX') && this.#entry(key)) return null;
    const ex = options.indexOf('EX');
    const expiresAt = ex >= 0 ? Date.now() + Number(options[ex + 1]) * 1000 : null;
    this.map.set(key, { value: String(value), expiresAt });
    return 'OK';
  }

  async del(...keys) {
    return keys.flat().reduce((count, key) => count + (this.map.delete(key) ? 1 : 0), 0);
  }

  async exists(key) {
    return this.#entry(key) ? 1 : 0;
  }

  async decr(key) {
    const entry = this.#entry(key);
    const next = (Number(entry?.value) || 0) - 1;
    this.map.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
    return next;
  }

  async keys(pattern) {
    const regex = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return [...this.map.keys()].filter((key) => regex.test(key) && this.#entry(key));
  }

  async releaseLock(key, token) {
    if (this.#entry(key)?.value !== token) return 0;
    this.map.delete(key);
    return 1;
  }

  async hitWindow(key, windowMs) {
    const now = Date.now();
    const entry = this.#entry(key);
    const hits = (Number(entry?.value) || 0) + 1;
    const expiresAt = entry?.expiresAt ?? now + Number(windowMs);
    this.map.set(key, { value: String(hits), expiresAt });
    return [hits, expiresAt - now];
  }

  async ping() {
    return 'PONG';
  }
}

let client = new MemoryStore();
let driver = 'memory';
/** Counts rate-limit hits in this process while Redis is unreachable, so limits still apply per instance. */
const local = new MemoryStore();

/** What to check for the usual Redis connection errors (same idea as the MongoDB hints in config/db.js). */
function redisHint(err) {
  const msg = err.message || '';
  if (/upstash\.io/.test(env.redisUrl) && env.redisUrl.startsWith('redis://')) {
    return ' -> Upstash only accepts TLS connections: REDIS_URL must start with rediss:// (two s)';
  }
  if (/WRONGPASS|NOAUTH|invalid password|invalid username/i.test(msg)) return ' -> Check the password in REDIS_URL (Upstash > your database > Connect)';
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return ' -> The Redis host could not be resolved; check the host in REDIS_URL';
  if (/NOSCRIPT|unknown command|EVAL/i.test(msg)) return ' -> This Redis does not allow Lua scripts (EVAL), which the locks and rate limits need';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed out|Connection is closed/i.test(msg)) {
    return ' -> Check the host and port in REDIS_URL, and that your network allows outgoing connections to it';
  }
  return '';
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return 'redis';
  }
};

/**
 * Connects to Redis when REDIS_URL is set. Development falls back to an in-memory store; production
 * refuses to start without a working Redis (unless ALLOW_MEMORY_CACHE=true), because locks, sessions and
 * rate limits only protect anything when every API instance shares them.
 */
export async function initCache() {
  const refuse = (reason) => new Error(`${reason}. Production needs Redis: locks, sessions and rate limits must be shared by every API instance (ALLOW_MEMORY_CACHE=true allows a single-instance demo without it)`);
  if (!env.redisUrl) {
    if (isProd && !env.allowMemoryCache) throw refuse('REDIS_URL is not set');
    logger.warn('Redis: REDIS_URL not set -> using in-memory cache (set REDIS_URL to use Redis)');
    return driver;
  }
  const redis = new Redis(env.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    // While disconnected, commands fail at once instead of queueing until the reconnect gives up (that held
    // each request for seconds per cache call); callers fall back to MongoDB, and locks answer 503.
    enableOfflineQueue: false,
    // A command that hangs (network trouble) fails instead of holding the request; callers then fall back.
    commandTimeout: 3000,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  redis.defineCommand('releaseLock', { numberOfKeys: 1, lua: RELEASE_LOCK });
  redis.defineCommand('hitWindow', { numberOfKeys: 1, lua: HIT_WINDOW });
  let lost = false;
  redis.on('error', (err) => logger.warn(`Redis error: ${err.message}`));
  redis.on('close', () => {
    if (driver !== 'redis' || lost) return;
    lost = true;
    logger.warn('Redis connection lost -> reconnecting (locks refuse and caches read MongoDB until it is back)');
  });
  redis.on('ready', () => {
    if (!lost) return;
    lost = false;
    logger.ok('Redis reconnected');
  });
  try {
    await redis.connect();
    await redis.ping();
    // Locks and rate limits run Lua scripts: check once here instead of failing on the first checkout.
    await redis.releaseLock(`${PREFIX}startup-check`, '-');
    client = redis;
    driver = 'redis';
    logger.ok(`Redis connected (${hostOf(env.redisUrl)}) -> sessions, locks, rate limits and caches are shared`);
  } catch (err) {
    redis.disconnect();
    const reason = `Redis unavailable (${err.message})${redisHint(err)}`;
    if (isProd && !env.allowMemoryCache) throw refuse(reason);
    logger.warn(`${reason} -> falling back to in-memory cache`);
  }
  return driver;
}

/** Closes the Redis connection (scripts that should exit when done). */
export async function closeCache() {
  if (driver === 'redis') await client.quit().catch(() => client.disconnect());
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

  /** False while Redis is configured but disconnected (it reconnects on its own). */
  get connected() {
    return driver === 'memory' || client.status === 'ready';
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

  async decr(key) {
    return safe(() => client.decr(k(key)), 0);
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

  /**
   * Takes a short lock in one command (SET NX EX) with a random token, so it always expires and only its
   * holder can release it. Returns a release function, or null when someone else holds the lock.
   * Unlike the other calls this one never falls back: if Redis can't be reached it throws 503, because a
   * lock that can't be checked must not be granted.
   */
  async lock(key, ttlSeconds) {
    const token = crypto.randomBytes(16).toString('hex');
    let taken;
    try {
      taken = await client.set(k(key), token, 'EX', ttlSeconds, 'NX');
    } catch (err) {
      logger.warn(`Lock ${key} unavailable: ${err.message}`);
      throw new ApiError(503, 'This action is temporarily unavailable. Please try again in a moment.', { code: 'LOCK_UNAVAILABLE' });
    }
    if (taken !== 'OK') return null;
    return () => safe(() => client.releaseLock(k(key), token), 0);
  },

  /**
   * Rate-limit window: counts one hit and returns { hits, resetMs }. If Redis can't be reached it counts
   * in this process instead, so limits keep working per instance rather than letting everything through.
   */
  async hit(key, windowMs) {
    try {
      const [hits, ttl] = await client.hitWindow(k(key), windowMs);
      return { hits: Number(hits), resetMs: Number(ttl) };
    } catch (err) {
      logger.warn(`Rate-limit counter unavailable (${err.message}) -> counting in this process`);
      const [hits, ttl] = await local.hitWindow(k(key), windowMs);
      return { hits, resetMs: ttl };
    }
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
