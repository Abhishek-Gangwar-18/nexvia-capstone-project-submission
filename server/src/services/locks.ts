import { cache } from './cache.ts';
import { ApiError } from '../utils/http.ts';

/**
 * Runs fn while holding the lock `key`. A second caller gets 409 with busyMessage. The lock expires after
 * ttlSeconds even if this process dies mid-way, and throws 503 when the lock store can't be reached.
 */
export async function withLock(key, ttlSeconds, busyMessage, fn) {
  const release = await cache.lock(`lock:${key}`, ttlSeconds);
  if (!release) throw new ApiError(409, busyMessage);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Runs fn while holding a short lock on one package, so two concurrent writes (double click, vendor and
 * admin at once, a return request racing the payout job) can't both pass their checks.
 */
export const withPackageLock = (packageId, fn) => withLock(`package:${packageId}`, 30, 'This package is being updated. Please try again.', fn);
