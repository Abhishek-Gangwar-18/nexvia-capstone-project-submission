/**
 * Blocked accounts: every API answer becomes 403 ACCOUNT_BLOCKED for the browser the account was used in,
 * public routes included, until an admin unblocks it or another account signs in there.
 * No database or Redis is touched: the models are stubbed and the cache runs in memory.
 * Run: pnpm test
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

const src = (path) => new URL(`../src/${path}`, import.meta.url).href;

const { env } = await import(src('config/env.ts'));
const { User } = await import(src('models/User.ts'));
const { Session } = await import(src('models/Session.ts'));
const { invalidateUser } = await import(src('services/session.ts'));
const { cache } = await import(src('services/cache.ts'));
const { createApp } = await import(src('app.ts'));

const blocked = new User({ name: 'Bad Actor', email: 'bad@vendora.dev', role: 'customer', status: 'blocked', blockedReason: 'Fraudulent orders', blockedAt: new Date('2026-10-30') });
const other = new User({ name: 'Family Member', email: 'family@vendora.dev', role: 'customer' });
const users = new Map([blocked, other].map((u) => [String(u._id), u]));
const SID = new mongoose.Types.ObjectId().toString();

User.findById = async (id) => users.get(String(id)) || null;
User.findOne = ({ email }) => ({ select: async () => [...users.values()].find((u) => u.email === email) || null });
for (const u of users.values()) {
  u.comparePassword = async () => true;
  u.save = async () => u;
}
// The blocked account's session was revoked when the admin blocked it.
Session.findOne = (filter) => ({
  select: () => ({ lean: async () => (filter.revokedReason === 'blocked' && String(filter._id) === SID ? { user: blocked._id } : null) }),
});
Session.create = async (doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc });
Session.exists = async () => null;

let base;
let server;
before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(async () => {
  blocked.status = 'blocked';
  await invalidateUser(blocked._id);
});

const call = async (method, path, { token, cookie, body, headers = {} }: Record<string, any> = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(cookie && { Cookie: cookie }),
      ...(body && { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body && JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('vendora_blocked=')) || '';
  return { status: res.status, body: await res.json(), setCookie, mark: setCookie.split(';')[0] };
};
const accessToken = (user) => jwt.sign({ sub: String(user._id), role: user.role, sid: SID }, env.jwtSecret, { expiresIn: '15m' });
const isBlockedAnswer = (res) => res.status === 403 && res.body.details?.code === 'ACCOUNT_BLOCKED';

describe('blocked account', () => {
  test('a signed-in blocked user is told why, and the browser is marked', async () => {
    const res = await call('GET', '/auth/me', { token: accessToken(blocked) });
    assert.ok(isBlockedAnswer(res), JSON.stringify(res.body));
    assert.equal(res.body.details.reason, 'Fraudulent orders');
    assert.match(res.setCookie, /HttpOnly/i);
    assert.match(res.setCookie, /Path=\/(;|$)/);
  });

  test('routes that work without signing in reject the blocked token too', async () => {
    assert.ok(isBlockedAnswer(await call('GET', `/products/${new mongoose.Types.ObjectId()}`, { token: accessToken(blocked) })));
  });

  test('the next click in an open tab is refused, even on a public page and with an expired token', async () => {
    assert.ok(isBlockedAnswer(await call('GET', '/no-such-route', { token: accessToken(blocked) })));
    const expired = jwt.sign({ sub: String(blocked._id), role: 'customer', sid: SID, exp: Math.floor(Date.now() / 1000) - 60 }, env.jwtSecret);
    assert.ok(isBlockedAnswer(await call('GET', '/no-such-route', { token: expired })));
    assert.ok(isBlockedAnswer(await call('GET', '/auth/status', { token: accessToken(blocked) })));
  });

  test('a stale "active" profile in the cache still gets ACCOUNT_BLOCKED, never a sign-out 401', async () => {
    // A request that raced the block re-cached the profile from before it; the session is revoked.
    await cache.setJSON(`user:${blocked._id}`, { ...blocked.toSafeJSON(), status: 'active' }, 60);
    const res = await call('GET', '/auth/me', { token: accessToken(blocked) });
    assert.ok(isBlockedAnswer(res), JSON.stringify(res.body));
  });

  test('an expired session ended by the block answers ACCOUNT_BLOCKED on refresh, not "log in again"', async () => {
    const res = await call('POST', '/auth/refresh', { cookie: `vendora_rt=${SID}.secret`, headers: { 'X-Requested-With': 'vendora' } });
    assert.ok(isBlockedAnswer(res), JSON.stringify(res.body));
    assert.ok(res.mark);
  });

  test('logging in to the blocked account (right password) shows the block', async () => {
    const res = await call('POST', '/auth/login', { body: { email: blocked.email, password: 'whatever1' } });
    assert.ok(isBlockedAnswer(res));
    assert.ok(res.mark);
  });

  test('a marked browser gets nothing from the API, signed out and on public routes', async () => {
    const { mark } = await call('GET', '/auth/me', { token: accessToken(blocked) });
    for (const [method, path, body] of [
      ['GET', '/no-such-route'],
      ['GET', '/categories'],
      ['POST', '/auth/register', { name: 'New Me', email: 'new@vendora.dev', password: 'Secret@123' }],
      ['POST', '/auth/refresh'],
    ]) {
      assert.ok(isBlockedAnswer(await call(method, path, { cookie: mark, body })), `${method} ${path} was not blocked`);
    }
  });

  test('another account signing in opens the browser again', async () => {
    const { mark } = await call('GET', '/auth/me', { token: accessToken(blocked) });
    const res = await call('POST', '/auth/login', { cookie: mark, body: { email: other.email, password: 'whatever1' } });
    assert.equal(res.status, 200);
    assert.match(res.setCookie, /^vendora_blocked=;/, 'the blocked mark was not cleared');
  });

  test('once unblocked, the mark is dropped on the next request', async () => {
    const { mark } = await call('GET', '/auth/me', { token: accessToken(blocked) });
    blocked.status = 'active';
    await invalidateUser(blocked._id);
    const res = await call('GET', '/no-such-route', { cookie: mark });
    assert.equal(res.status, 404);
    assert.match(res.setCookie, /^vendora_blocked=;/);
  });

  test('a forged mark is ignored', async () => {
    const forged = jwt.sign({ sub: String(other._id), typ: 'blocked' }, 'not-the-secret');
    const res = await call('GET', '/no-such-route', { cookie: `vendora_blocked=${forged}` });
    assert.equal(res.status, 404);
  });
});
