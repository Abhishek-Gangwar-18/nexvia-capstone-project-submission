/**
 * Live check of the Redis in REDIS_URL: connection, latency, locks, rate-limit counters and cached values.
 * Writes only a few short-lived keys under vendora:check:* and deletes them. MongoDB is not touched.
 * Run: pnpm redis:check
 */
import { env } from '../src/config/env.js';
import { cache, closeCache, initCache } from '../src/services/cache.js';
import { withLock } from '../src/services/locks.js';

let failed = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}${detail ? ` (${detail})` : ''}`);
  } catch (err) {
    failed += 1;
    console.log(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
  }
}
const expect = (ok, message) => {
  if (!ok) throw new Error(message);
};

if (!env.redisUrl) {
  console.log('REDIS_URL is not set in server/.env');
  process.exit(1);
}
if ((await initCache()) !== 'redis') {
  console.log('\nCould not connect to Redis (see the warning above).');
  process.exit(1);
}

console.log('\nRedis checks:');
await check('ping', async () => {
  const start = Date.now();
  expect((await cache.ping()) === 'PONG', 'no PONG');
  return `${Date.now() - start} ms round trip`;
});
await check('lock: taken once, refused while held, free after release', async () => {
  const release = await cache.lock('check:lock', 10);
  expect(release, 'could not take a free lock');
  expect((await cache.lock('check:lock', 10)) === null, 'a held lock was granted twice');
  await release();
  const again = await cache.lock('check:lock', 10);
  expect(again, 'the lock was not released');
  await again();
});
await check('lock: a second concurrent caller gets 409', async () => {
  let finish;
  const first = withLock('check:busy', 10, 'busy', () => new Promise((resolve) => (finish = resolve)));
  const second = await withLock('check:busy', 10, 'busy', async () => 'ran').catch((err) => err.status);
  finish();
  await first;
  expect(second === 409, `expected 409, got ${second}`);
});
await check('rate-limit counter counts and expires its window', async () => {
  const one = await cache.hit('check:rl', 5000);
  const two = await cache.hit('check:rl', 5000);
  expect(one.hits === 1 && two.hits === 2, `counted ${one.hits}, ${two.hits}`);
  expect(two.resetMs > 0 && two.resetMs <= 5000, `window ${two.resetMs} ms`);
});
await check('cached JSON round trip', async () => {
  await cache.setJSON('check:json', { ok: true }, 10);
  expect((await cache.getJSON('check:json'))?.ok === true, 'value did not come back');
});
await cache.del('check:lock', 'check:busy', 'check:rl', 'check:json');

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll Redis checks passed.');
await closeCache();
process.exit(failed ? 1 : 0);
