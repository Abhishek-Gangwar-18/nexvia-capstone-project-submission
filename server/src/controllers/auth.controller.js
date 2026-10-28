import { z } from 'zod';
import { User } from '../models/User.js';
import { Vendor } from '../models/Vendor.js';
import { Product } from '../models/Product.js';
import { createSession, invalidateUser, revokeSession } from '../services/session.js';
import { CARD_FIELDS, toCard } from '../services/catalog.js';
import { ApiError } from '../utils/http.js';

const email = z.string().trim().toLowerCase().email('Enter a valid email address');
const phone = z.string().trim().regex(/^[0-9+\-\s]{8,15}$/, 'Enter a valid phone number');

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(60),
  email,
  password: z.string().min(6, 'Password must be at least 6 characters').max(100),
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
  newPassword: z.string().min(6, 'New password must be at least 6 characters').max(100),
});

export const addressSchema = z.object({
  label: z.string().trim().max(30).default('Home'),
  fullName: z.string().trim().min(2, 'Full name is required'),
  phone,
  line1: z.string().trim().min(3, 'Address line 1 is required'),
  line2: z.string().trim().max(120).optional().default(''),
  city: z.string().trim().min(2, 'City is required'),
  state: z.string().trim().min(2, 'State is required'),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits'),
  country: z.string().trim().default('India'),
  isDefault: z.boolean().optional().default(false),
});

async function profile(userDoc) {
  const user = userDoc.toSafeJSON();
  const vendor = user.role === 'vendor' ? await Vendor.findOne({ user: user._id }).lean() : null;
  return { ...user, vendor };
}

export async function register(req, res) {
  const { name, email: mail, password, role } = req.body;
  if (await User.exists({ email: mail })) throw new ApiError(409, 'An account with this email already exists');
  const user = await User.create({ name, email: mail, password, role });
  const token = await createSession(user);
  res.status(201).json({ token, user: await profile(user) });
}

export async function login(req, res) {
  const user = await User.findOne({ email: req.body.email }).select('+password');
  if (!user || !(await user.comparePassword(req.body.password))) throw new ApiError(401, 'Incorrect email or password');
  if (user.isBlocked) throw new ApiError(403, 'Your account has been suspended. Please contact support.');
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
  const user = await User.findByIdAndUpdate(req.user._id, { $set: req.body }, { new: true, runValidators: true });
  await invalidateUser(user._id);
  res.json({ user: await profile(user) });
}

export async function changePassword(req, res) {
  const user = await User.findById(req.user._id).select('+password');
  if (!(await user.comparePassword(req.body.currentPassword))) throw new ApiError(400, 'Current password is incorrect');
  user.password = req.body.newPassword;
  await user.save();
  res.json({ message: 'Password updated' });
}

/* ------------------------------------------------------------- addresses */

const setDefault = (user, addressId) => {
  user.addresses.forEach((a) => {
    a.isDefault = String(a._id) === String(addressId);
  });
};

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
    populate: { path: 'vendor', select: 'storeName slug' },
  });
  res.json({ items: user.wishlist.filter(Boolean).map((p) => toCard(p.toObject())) });
}

export async function toggleWishlist(req, res) {
  const { productId } = req.params;
  if (!(await Product.exists({ _id: productId }))) throw new ApiError(404, 'Product not found');
  const user = await User.findById(req.user._id);
  const exists = user.wishlist.some((id) => String(id) === productId);
  if (exists) user.wishlist.pull(productId);
  else user.wishlist.addToSet(productId);
  await user.save();
  await invalidateUser(user._id);
  res.json({ added: !exists, wishlist: user.wishlist.map(String) });
}
