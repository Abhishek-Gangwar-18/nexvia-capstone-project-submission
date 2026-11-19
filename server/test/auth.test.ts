/**
 * Auth middleware: what `protect` accepts and refuses (missing, forged, expired tokens, ended sessions,
 * changed passwords, blocked accounts), role checks in `authorize`, and the seller gate in `loadVendor`.
 * No database is touched: the session service and the Vendor model are faked.
 * Run: pnpm test
 */
import { beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

const src = (path) => new URL(`../src/${path}`, import.meta.url).href;

const users = new Map();
let activeSessions = new Set();
mock.module(src('services/session.ts'), {
  exports: {
    REFRESH_COOKIE: 'vendora_rt',
    loadSessionUser: async (id) => users.get(String(id)) || null,
    isSessionActive: async (sid) => activeSessions.has(String(sid)),
    blockedSessionOwner: async () => null,
    accountBlocked: (user) => Object.assign(new Error('Account blocked'), { status: 403, blockedUserId: String(user._id) }),
  },
});

const { env } = await import(src('config/env.ts'));
const { Vendor } = await import(src('models/Vendor.ts'));
const { protect, optionalAuth, authorize, loadVendor } = await import(src('middleware/auth.ts'));

const customer: Record<string, any> = { _id: new mongoose.Types.ObjectId(), role: 'customer', status: 'active' };
const SID = new mongoose.Types.ObjectId().toString();

beforeEach(() => {
  users.clear();
  users.set(String(customer._id), customer);
  delete customer.passwordChangedAt;
  customer.status = 'active';
  activeSessions = new Set([SID]);
});

const sign = (payload = {}, options = {}) => jwt.sign({ sub: String(customer._id), sid: SID, ...payload }, env.jwtSecret, { expiresIn: '15m', ...options });

/** Runs an Express middleware and resolves with the error it passed on (null when it let the request through). */
function run(middleware, { authorization, user }: Record<string, any> = {}) {
  const req: Record<string, any> = { headers: authorization ? { authorization } : {}, user };
  const headers = {};
  const res = { set: (k, v) => { headers[k] = v; } };
  return new Promise<{ err: any; req: any; headers: any }>((resolve) => {
    middleware(req, res, (err) => resolve({ err: err || null, req, headers }));
  });
}

describe('protect', () => {
  test('a valid token for an active session lets the request through', async () => {
    const { err, req, headers } = await run(protect, { authorization: `Bearer ${sign()}` });
    assert.equal(err, null);
    assert.equal(req.user, customer);
    assert.equal(req.auth.sid, SID);
    assert.equal(headers['X-Session'], 'active');
  });

  test('no token, or a non-Bearer header, needs a login', async () => {
    assert.equal((await run(protect)).err.status, 401);
    assert.equal((await run(protect, { authorization: sign() })).err.status, 401);
    assert.equal((await run(protect, { authorization: `Basic ${sign()}` })).err.status, 401);
  });

  test('a token signed with another secret is refused as invalid', async () => {
    const forged = jwt.sign({ sub: String(customer._id), sid: SID }, 'not-the-server-secret');
    const { err } = await run(protect, { authorization: `Bearer ${forged}` });
    assert.equal(err.status, 401);
    assert.equal(err.details?.code, 'INVALID_TOKEN');
  });

  test('an edited token (role changed in the payload) is refused', async () => {
    const [header, , signature] = sign().split('.');
    const payload = Buffer.from(JSON.stringify({ sub: String(customer._id), sid: SID, role: 'admin' })).toString('base64url');
    const { err } = await run(protect, { authorization: `Bearer ${header}.${payload}.${signature}` });
    assert.equal(err.status, 401);
  });

  test('a token with alg "none" is refused', async () => {
    const unsigned = jwt.sign({ sub: String(customer._id), sid: SID }, '', { algorithm: 'none' });
    const { err } = await run(protect, { authorization: `Bearer ${unsigned}` });
    assert.equal(err.status, 401);
  });

  test('an expired token asks the client to refresh', async () => {
    const expired = sign({ iat: Math.floor(Date.now() / 1000) - 3600 }, { expiresIn: '1s' });
    const { err } = await run(protect, { authorization: `Bearer ${expired}` });
    assert.equal(err.status, 401);
    assert.equal(err.details?.code, 'TOKEN_EXPIRED');
  });

  test('a deleted account is refused', async () => {
    users.clear();
    assert.equal((await run(protect, { authorization: `Bearer ${sign()}` })).err.status, 401);
  });

  test('a logged-out session is refused even with an unexpired token', async () => {
    activeSessions.clear();
    const { err } = await run(protect, { authorization: `Bearer ${sign()}` });
    assert.equal(err.status, 401);
    assert.equal(err.details?.code, 'SESSION_ENDED');
  });

  test('tokens issued before a password change are refused', async () => {
    const token = sign({ iat: Math.floor(Date.now() / 1000) - 60 });
    customer.passwordChangedAt = new Date();
    const { err } = await run(protect, { authorization: `Bearer ${token}` });
    assert.equal(err.status, 401);
    assert.match(err.message, /password was changed/);
  });

  test('a blocked account is told it is blocked', async () => {
    customer.status = 'blocked';
    const { err } = await run(protect, { authorization: `Bearer ${sign()}` });
    assert.equal(err.status, 403);
  });
});

describe('optionalAuth', () => {
  test('no header: carries on as a guest', async () => {
    const { err, req } = await run(optionalAuth);
    assert.equal(err, null);
    assert.equal(req.user, undefined);
  });

  test('a bad token is ignored instead of failing a public page', async () => {
    const { err, req } = await run(optionalAuth, { authorization: 'Bearer garbage' });
    assert.equal(err, null);
    assert.equal(req.user, undefined);
  });

  test('a blocked account is still refused', async () => {
    customer.status = 'blocked';
    const { err } = await run(optionalAuth, { authorization: `Bearer ${sign()}` });
    assert.equal(err.status, 403);
  });
});

describe('authorize', () => {
  test('only the listed roles pass', async () => {
    const adminOnly = authorize('admin');
    assert.equal((await run(adminOnly, { user: { role: 'admin' } })).err, null);
    assert.equal((await run(adminOnly, { user: { role: 'vendor' } })).err.status, 403);
    assert.equal((await run(adminOnly, { user: { role: 'customer' } })).err.status, 403);
    assert.equal((await run(adminOnly)).err.status, 403);
    assert.equal((await run(authorize('vendor', 'admin'), { user: { role: 'vendor' } })).err, null);
  });
});

describe('loadVendor', () => {
  const seller = { _id: new mongoose.Types.ObjectId(), role: 'vendor' };

  test('a seller without a store is sent to onboarding', async () => {
    Vendor.findOne = async () => null;
    const { err } = await run(loadVendor(), { user: seller });
    assert.equal(err.status, 403);
    assert.equal(err.details?.code, 'VENDOR_ONBOARDING_REQUIRED');
  });

  test('a pending or suspended store is blocked until approved', async () => {
    for (const status of ['pending', 'suspended', 'rejected']) {
      Vendor.findOne = async () => ({ status });
      const { err } = await run(loadVendor(), { user: seller });
      assert.equal(err.status, 403);
      assert.equal(err.details?.code, 'VENDOR_NOT_APPROVED');
    }
  });

  test('an approved store loads, and approval can be waived for onboarding pages', async () => {
    const store = { status: 'approved' };
    Vendor.findOne = async () => store;
    const ok = await run(loadVendor(), { user: seller });
    assert.equal(ok.err, null);
    assert.equal(ok.req.vendor, store);
    Vendor.findOne = async () => ({ status: 'pending' });
    assert.equal((await run(loadVendor({ approved: false }), { user: seller })).err, null);
  });
});
