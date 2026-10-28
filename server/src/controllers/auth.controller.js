import { z } from 'zod';
import { User, WISHLIST_MAX } from '../models/User.js';
import { Vendor } from '../models/Vendor.js';
import { Product } from '../models/Product.js';
import { createSession, invalidateUser, revokeSession } from '../services/session.js';
import { CARD_FIELDS, toCard } from '../services/catalog.js';
import { confirmVerification, issueVerification } from '../services/emailVerification.js';
import { cache } from '../services/cache.js';
import { ApiError } from '../utils/http.js';
import { address as addressFields, email, password, phone } from '../utils/validators.js';

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

export const verifyEmailSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid verification link') });

// Partial update: absent fields are left untouched (optional() skips the defaults above).
export const addressUpdateSchema = addressSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to update');

async function profile(userDoc) {
  const user = userDoc.toSafeJSON();
  const vendor = user.role === 'vendor' ? await Vendor.findOne({ user: user._id }).lean() : null;
  return { ...user, vendor };
}

export async function register(req, res) {
  const { name, email: mail, password, role } = req.body;
  if (await User.exists({ email: mail })) throw new ApiError(409, 'An account with this email already exists');
  const user = await User.create({ name, email: mail, password, role });
  await issueVerification(user);
  const token = await createSession(user);
  res.status(201).json({ token, user: await profile(user) });
}

export async function login(req, res) {
  const user = await User.findOne({ email: req.body.email }).select('+password');
  if (!user || !(await user.comparePassword(req.body.password))) throw new ApiError(401, 'Incorrect email or password');
  if (user.status === 'blocked') throw new ApiError(403, 'Your account has been suspended. Please contact support.');
  user.lastLoginAt = new Date();
  await user.save();
  const token = await createSession(user);
  res.json({ token, user: await profile(user) });
}

export async function logout(req, res) {
  await revokeSession(req.auth);
  res.json({ message: 'Logged out' });
}

export async function me(req, res) {
  const user = await User.findById(req.user._id);
  if (!user) throw new ApiError(404, 'Account not found');
  res.json({ user: await profile(user) });
}

export async function updateMe(req, res) {
  const { phone: newPhone, ...rest } = req.body;
  const update = { $set: rest };
  // An empty phone is removed rather than stored, so it never collides in the unique index.
  if (newPhone === '') update.$unset = { phone: 1 };
  else if (newPhone) {
    if (await User.exists({ phone: newPhone, _id: { $ne: req.user._id } })) throw new ApiError(409, 'This phone number is already registered');
    rest.phone = newPhone;
  }
  const user = await User.findByIdAndUpdate(req.user._id, update, { new: true, runValidators: true });
  await invalidateUser(user._id);
  res.json({ user: await profile(user) });
}

export async function changePassword(req, res) {
  const user = await User.findById(req.user._id).select('+password');
  if (!(await user.comparePassword(req.body.currentPassword))) throw new ApiError(400, 'Current password is incorrect');
  user.password = req.body.newPassword;
  user.passwordChangedAt = new Date();
  await user.save();
  // Every older token (other devices included) now fails in protect(); hand this device a fresh one.
  await revokeSession(req.auth);
  await invalidateUser(user._id);
  const token = await createSession(user);
  res.json({ message: 'Password updated. Other devices have been logged out.', token });
}

/* ------------------------------------------------------ email verification */

export async function verifyEmail(req, res) {
  const user = await confirmVerification(req.body.token);
  if (!user) throw new ApiError(400, 'This verification link is invalid or has expired. Request a new one.');
  res.json({ message: 'Email verified', user: await profile(user) });
}

const RESEND_COOLDOWN = 60;
const RESEND_DAILY_MAX = 5;

export async function resendVerification(req, res) {
  if (req.user.emailVerified) throw new ApiError(400, 'Your email is already verified');
  const id = req.user._id;
  if (await cache.exists(`verify-cooldown:${id}`)) throw new ApiError(429, 'Please wait a minute before requesting another email');
  if ((await cache.incrWithTtl(`verify-daily:${id}`, 24 * 60 * 60)) > RESEND_DAILY_MAX) {
    throw new ApiError(429, 'Daily limit reached for verification emails. Try again tomorrow.');
  }
  await cache.set(`verify-cooldown:${id}`, '1', RESEND_COOLDOWN);
  await issueVerification(req.user);
  res.json({ message: `Verification email sent to ${req.user.email}` });
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
