import { z } from 'zod';
import { User, WISHLIST_MAX } from '../models/User.ts';
import { Vendor } from '../models/Vendor.ts';
import { Product } from '../models/Product.ts';
import mongoose from 'mongoose';
import {
  accountBlocked,
  createSession,
  invalidateUser,
  listSessions,
  refreshSession,
  revokeAllSessions,
  revokeByRefreshToken,
  revokeSession,
  revokeUserSession,
} from '../services/session.ts';
import { clearBlockedCookie, clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../utils/cookies.ts';
import { CARD_FIELDS, toCard } from '../services/catalog.ts';
import { deleteReplaced } from '../services/storage.ts';
import { ApiError } from '../utils/http.ts';
import { address as addressFields, email, password, phone } from '../utils/validators.ts';

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(60),
  email,
  password: password(),
  // Admins are never self-registered; they are created outside the app.
  role: z.enum(['customer', 'vendor']).default('customer'),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required'),
});

export const profileSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  phone: phone.or(z.literal('')).optional(),
  avatar: z.string().url().or(z.literal('')).optional(),
});

export const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: password('New password'),
});

export const addressSchema = addressFields.extend({
  label: z.string().trim().max(30).default('Home'),
  fullName: z.string().trim().min(2, 'Full name is required'),
  phone,
  isDefault: z.boolean().optional().default(false),
});

// Partial update: absent fields are left untouched (optional() skips the defaults above).
export const addressUpdateSchema = addressSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to update');

/**
 * Starts a session: the refresh token goes in the httpOnly cookie, the access token in the body.
 * A browser marked as blocked opens again only when an account that isn't blocked signs in there.
 */
async function signIn(res, user, req) {
  const { accessToken, refreshToken, refreshExpiresAt } = await createSession(user, req);
  setRefreshCookie(res, refreshToken, refreshExpiresAt);
  clearBlockedCookie(res);
  return accessToken;
}

async function profile(userDoc) {
  const user = userDoc.toSafeJSON();
  const vendor = user.role === 'vendor' ? await Vendor.findOne({ user: user._id }).lean() : null;
  return { ...user, vendor };
}

export async function register(req, res) {
  const { name, email: mail, password, role } = req.body;
  if (await User.exists({ email: mail })) throw new ApiError(409, 'An account with this email already exists');
  const user = await User.create({ name, email: mail, password, role });
  const accessToken = await signIn(res, user, req);
  res.status(201).json({ accessToken, user: await profile(user) });
}

export async function login(req, res) {
  const user = await User.findOne({ email: req.body.email }).select('+password');
  if (!user || !(await user.comparePassword(req.body.password))) throw new ApiError(401, 'Incorrect email or password');
  if (user.status === 'blocked') throw accountBlocked(user);
  user.lastLoginAt = new Date();
  await user.save();
  const accessToken = await signIn(res, user, req);
  res.json({ accessToken, user: await profile(user) });
}

/**
 * POST /auth/refresh (refresh cookie only): new access token + rotated refresh cookie.
 * The custom header is a CSRF guard: another site can't send it without passing CORS.
 */
export async function refresh(req, res) {
  if (req.get('x-requested-with') !== 'vendora') throw new ApiError(403, 'Missing X-Requested-With header');
  try {
    const result = await refreshSession(readRefreshCookie(req));
    if (result.refreshToken) setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt);
    res.json({ accessToken: result.accessToken, user: await profile(result.user) });
  } catch (err) {
    clearRefreshCookie(res);
    throw err;
  }
}

/** Ends this device's session. Works from the cookie even when the access token has already expired. */
export async function logout(req, res) {
  const cookie = readRefreshCookie(req);
  if (cookie) await revokeByRefreshToken(cookie);
  else if (req.auth?.sid) await revokeSession(req.auth.sid);
  clearRefreshCookie(res);
  res.json({ message: 'Logged out' });
}

/** Ends every session of the account, this device included. */
export async function logoutAll(req, res) {
  const count = await revokeAllSessions(req.user._id, 'logout_all');
  clearRefreshCookie(res);
  res.json({ message: `Logged out of ${count} device(s)` });
}

export async function sessions(req, res) {
  const list = await listSessions(req.user._id);
  res.json({ sessions: list.map((s) => ({ ...s, current: String(s._id) === String(req.auth.sid) })) });
}

/** Logs out one of your other devices. */
export async function revokeDevice(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid session id');
  const count = await revokeUserSession(req.user._id, req.params.id);
  if (!count) throw new ApiError(404, 'Session not found');
  if (String(req.params.id) === String(req.auth.sid)) clearRefreshCookie(res);
  res.json({ message: 'Device logged out' });
}

/** Cheap "is my session still good?" check the client makes on every page change (protect does the work). */
export const status = (_req, res) => res.json({ ok: true });

export async function me(req, res) {
  const user = await User.findById(req.user._id);
  if (!user) throw new ApiError(404, 'Account not found');
  res.json({ user: await profile(user) });
}

export async function updateMe(req, res) {
  const { phone: newPhone, ...rest } = req.body;
  const update = { $set: rest };
  // An empty phone is removed rather than stored, so it never collides in the unique index.
  if (newPhone === '') (update as Record<string, any>).$unset = { phone: 1 };
  else if (newPhone) {
    if (await User.exists({ phone: newPhone, _id: { $ne: req.user._id } })) throw new ApiError(409, 'This phone number is already registered');
    rest.phone = newPhone;
  }
  const before = 'avatar' in rest ? await User.findById(req.user._id).select('avatar').lean() : null;
  const user = await User.findByIdAndUpdate(req.user._id, update, { new: true, runValidators: true });
  await invalidateUser(user._id);
  if (before) deleteReplaced([before.avatar], [user.avatar], user._id);
  res.json({ user: await profile(user) });
}

export async function changePassword(req, res) {
  const user = await User.findById(req.user._id).select('+password');
  if (!(await user.comparePassword(req.body.currentPassword))) throw new ApiError(400, 'Current password is incorrect');
  user.password = req.body.newPassword;
  user.passwordChangedAt = new Date();
  await user.save();
  // Every other device is logged out; this one gets a fresh session (older access tokens fail the iat check).
  await revokeAllSessions(user._id, 'password_change');
  await invalidateUser(user._id);
  const accessToken = await signIn(res, user, req);
  res.json({ message: 'Password updated. Other devices have been logged out.', accessToken });
}

/* ------------------------------------------------------------- addresses */

const setDefault = (user, addressId) => {
  user.addresses.forEach((a) => {
    a.isDefault = String(a._id) === String(addressId);
  });
};

export async function listAddresses(req, res) {
  const user = await User.findById(req.user._id).select('addresses');
  res.json({ addresses: user.addresses });
}

export async function addAddress(req, res) {
  const user = await User.findById(req.user._id);
  if (user.addresses.length >= 10) throw new ApiError(400, 'You can save up to 10 addresses');
  user.addresses.push(req.body);
  const added = user.addresses[user.addresses.length - 1];
  if (req.body.isDefault || user.addresses.length === 1) setDefault(user, added._id);
  await user.save();
  await invalidateUser(user._id);
  res.status(201).json({ addresses: user.addresses, address: added });
}

export async function updateAddress(req, res) {
  const user = await User.findById(req.user._id);
  const address = user.addresses.id(req.params.addressId);
  if (!address) throw new ApiError(404, 'Address not found');
  Object.assign(address, req.body);
  if (req.body.isDefault) setDefault(user, address._id);
  await user.save();
  await invalidateUser(user._id);
  res.json({ addresses: user.addresses });
}

export async function deleteAddress(req, res) {
  const user = await User.findById(req.user._id);
  const address = user.addresses.id(req.params.addressId);
  if (!address) throw new ApiError(404, 'Address not found');
  const wasDefault = address.isDefault;
  address.deleteOne();
  if (wasDefault && user.addresses.length) user.addresses[0].isDefault = true;
  await user.save();
  await invalidateUser(user._id);
  res.json({ addresses: user.addresses });
}

/* -------------------------------------------------------------- wishlist */

export async function getWishlist(req, res) {
  const user = await User.findById(req.user._id).populate({
    path: 'wishlist',
    select: CARD_FIELDS,
    populate: { path: 'vendor', select: 'storeName' },
  });
  res.json({ items: user.wishlist.filter(Boolean).map((p) => toCard(p.toObject())) });
}

async function setWishlisted(req, res, wishlisted) {
  const { productId } = req.params;
  if (!(await Product.exists({ _id: productId }))) throw new ApiError(404, 'Product not found');
  const user = await User.findById(req.user._id);
  if (wishlisted && user.wishlist.length >= WISHLIST_MAX && !user.wishlist.some((id) => String(id) === productId)) {
    throw new ApiError(400, `Your wishlist can hold up to ${WISHLIST_MAX} products`);
  }
  if (wishlisted) user.wishlist.addToSet(productId);
  else user.wishlist.pull(productId);
  await user.save();
  await invalidateUser(user._id);
  res.json({ wishlisted, wishlist: user.wishlist.map(String) });
}

/** Idempotent: repeating either call leaves the wishlist in the same state. */
export const addToWishlist = (req, res) => setWishlisted(req, res, true);
export const removeFromWishlist = (req, res) => setWishlisted(req, res, false);
