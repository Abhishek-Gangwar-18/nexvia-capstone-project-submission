import { cache } from './cache.js';

/**
 * express-rate-limit store on the shared cache (Redis when configured), so a limit holds across every API
 * instance and survives restarts. Use one store per limiter: the name keeps their counters apart.
 */
export class CacheStore {
  constructor(name) {
    this.prefix = `rl:${name}:`;
  }

  /** Counters live in this process only in memory mode. */
  get localKeys() {
    return cache.driver === 'memory';
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    const { hits, resetMs } = await cache.hit(this.prefix + key, this.windowMs);
    return { totalHits: hits, resetTime: new Date(Date.now() + resetMs) };
  }

  async decrement(key) {
    await cache.decr(this.prefix + key);
  }

  async resetKey(key) {
    await cache.del(this.prefix + key);
  }
}
