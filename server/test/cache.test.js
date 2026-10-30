/**
 * Cache layer: locks, rate-limit counters and what happens when Redis is down or missing.
 * Redis is replaced by an in-process fake (ioredis is mocked), so nothing connects to a real server.
 * Run: pnpm test
 */
import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';

const src = (path) => new URL(`../src/${path}`, import.meta.url).href;

/** Stands in for an ioredis client; `down` makes every command fail like a dropped connection. */
class FakeRedis {
  static last = null;

  constructor(url) {
    this.url = url;
    this.status = 'wait';
    this.down = false;
    this.data = new Map();
    this.scripts = [];
    FakeRedis.last = this;
  }

  on() {
    return this;
  }

  defineCommand(name) {
    this.scripts.push(name);
  }

  #check() {
    if (this.down) throw new Error('Connection is closed.');
  }

  async connect() {
    this.status = 'ready';
  }

  disconnect() {
    this.status = 'end';
  }

  async ping() {
    this.#check();
    return 'PONG';
  }

  async get(key) {
    this.#check();
    return this.data.get(key) ?? null;
  }

  async set(key, value, ...options) {
    this.#check();
    if (options.includes('NX') && this.data.has(key)) return null;
    this.data.set(key, String(value));
    return 'OK';
  }

  async del(...keys) {
    this.#check();
    return keys.reduce((n, key) => n + (this.data.delete(key) ? 1 : 0), 0);
  }

  async releaseLock(key, token) {
    this.#check();
    if (this.data.get(key) !== token) return 0;
    this.data.delete(key);
    return 1;
  }

  async hitWindow(key, windowMs) {
    this.#check();
    const hits = Number(this.data.get(key) || 0) + 1;
    this.data.set(key, String(hits));
    return [hits, windowMs];
  }
}

process.env.REDIS_URL = 'redis://fake-host:6379';
mock.module('ioredis', { exports: { default: FakeRedis } });

const { cache, initCache } = await import(src('services/cache.js'));
const { withLock } = await import(src('services/locks.js'));
const { CacheStore } = await import(src('services/rateLimitStore.js'));

describe('locks (in-memory store)', () => {
  test('a held lock is refused to a second caller and free again once released', async () => {
    const release = await cache.lock('t:a', 30);
    assert.ok(release);
    assert.equal(await cache.lock('t:a', 30), null);
    await release();
    const again = await cache.lock('t:a', 30);
    assert.ok(again);
    await again();
  });

  test('a holder whose lock expired cannot release the lock someone else took since', async () => {
    const first = await cache.lock('t:b', 30);
    await cache.del('t:b'); // the first holder's lock ran out
    const second = await cache.lock('t:b', 30);
    await first(); // late release from the first holder
    assert.equal(await cache.lock('t:b', 30), null, 'the second holder still has it');
    await second();
  });

  test('withLock returns 409 while busy and always releases, even when fn throws', async () => {
    await assert.rejects(withLock('t:c', 30, 'busy', async () => { throw new Error('boom'); }), /boom/);
    let finish;
    const running = withLock('t:c', 30, 'busy', () => new Promise((resolve) => (finish = resolve)));
    await assert.rejects(withLock('t:c', 30, 'busy', async () => 'second'), (err) => err.status === 409 && err.message === 'busy');
    finish('done');
    assert.equal(await running, 'done');
  });

  test('a lock expires on its own (a crashed holder never blocks it forever)', async () => {
    await cache.lock('t:d', 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.ok(await cache.lock('t:d', 1));
  });
});

describe('rate-limit store', () => {
  const store = (name, windowMs = 60 * 1000) => {
    const s = new CacheStore(name);
    s.init({ windowMs });
    return s;
  };

  test('counts hits per key in a window and reports when it resets', async () => {
    const s = store('t1');
    const before = Date.now();
    assert.equal((await s.increment('1.2.3.4')).totalHits, 1);
    const second = await s.increment('1.2.3.4');
    assert.equal(second.totalHits, 2);
    assert.ok(second.resetTime.getTime() > before && second.resetTime.getTime() <= before + 60 * 1000 + 50);
    assert.equal((await s.increment('5.6.7.8')).totalHits, 1, 'other clients have their own counter');
  });

  test('limiters with different names never share counters, and resetKey clears one', async () => {
    const a = store('t2a');
    const b = store('t2b');
    await a.increment('ip');
    await a.increment('ip');
    assert.equal((await b.increment('ip')).totalHits, 1);
    await a.resetKey('ip');
    assert.equal((await a.increment('ip')).totalHits, 1);
  });

  test('a window ends after windowMs', async () => {
    const s = store('t3', 200);
    await s.increment('ip');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal((await s.increment('ip')).totalHits, 1);
  });
});

describe('with Redis', () => {
  test('connects, registers the lock and rate-limit scripts, and becomes the driver', async () => {
    assert.equal(await initCache(), 'redis');
    assert.equal(cache.driver, 'redis');
    assert.deepEqual(FakeRedis.last.scripts.sort(), ['hitWindow', 'releaseLock']);
  });

  test('locks and counters go through Redis', async () => {
    const release = await cache.lock('r:a', 30);
    assert.ok(FakeRedis.last.data.has('vendora:r:a'));
    await release();
    assert.ok(!FakeRedis.last.data.has('vendora:r:a'));
    await cache.hit('r:hits', 1000);
    assert.equal(FakeRedis.last.data.get('vendora:r:hits'), '1');
  });

  test('Redis down: a lock is refused with 503 instead of being granted', async () => {
    FakeRedis.last.down = true;
    try {
      await assert.rejects(cache.lock('r:b', 30), (err) => err.status === 503);
      await assert.rejects(withLock('r:b', 30, 'busy', async () => 'ran'), (err) => err.status === 503);
    } finally {
      FakeRedis.last.down = false;
    }
  });

  test('Redis down: rate limits keep counting in this process, and reads behave like a cache miss', async () => {
    FakeRedis.last.down = true;
    try {
      const s = new CacheStore('down');
      s.init({ windowMs: 60 * 1000 });
      assert.equal((await s.increment('ip')).totalHits, 1);
      assert.equal((await s.increment('ip')).totalHits, 2);
      assert.equal(await cache.getJSON('anything'), null);
      assert.equal(await cache.remember('computed', 60, async () => 42), 42);
    } finally {
      FakeRedis.last.down = false;
    }
  });
});

describe('Redis in production', () => {
  /** Starts the cache in a fresh process with the given environment; prints started / refused. */
  const run = async (vars) => {
    const script = `
      Object.assign(process.env, ${JSON.stringify({ NODE_ENV: 'production', ALLOW_MEMORY_CACHE: '', ...vars })});
      const { initCache } = await import(${JSON.stringify(src('services/cache.js'))});
      try { await initCache(); console.log('started'); } catch (e) { console.log('refused'); }
      process.exit(0);`;
    const { execFileSync } = await import('node:child_process');
    return execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim().split('\n').pop();
  };

  test('the server refuses to start without REDIS_URL unless ALLOW_MEMORY_CACHE is set', async () => {
    assert.equal(await run({ REDIS_URL: '' }), 'refused');
    assert.equal(await run({ REDIS_URL: '', ALLOW_MEMORY_CACHE: 'true' }), 'started');
  });

  test('the server refuses to start when REDIS_URL is set but Redis is unreachable', async () => {
    // Port 1 on this machine: refused at once, nothing outside the machine is contacted.
    assert.equal(await run({ REDIS_URL: 'redis://127.0.0.1:1' }), 'refused');
  });
});
