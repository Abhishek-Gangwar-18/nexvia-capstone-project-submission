import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { addressSchema, presentString } from './address.js';

export const ROLES = ['customer', 'vendor', 'admin'];
export const USER_STATUSES = ['active', 'blocked'];
export const WISHLIST_MAX = 200;
const BCRYPT_ROUNDS = 12;

const userAddressSchema = addressSchema({
  label: { type: String, default: 'Home', trim: true },
  fullName: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  isDefault: { type: Boolean, default: false },
});

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 8, select: false },
    /** Tokens issued before this instant are rejected (see middleware/auth.js). */
    passwordChangedAt: Date,
    role: { type: String, enum: ROLES, default: 'customer', index: true },
    phone: { type: String, trim: true },
    avatar: String,
    addresses: [userAddressSchema],
    wishlist: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
      validate: { validator: (v) => v.length <= WISHLIST_MAX, message: `Wishlist can hold up to ${WISHLIST_MAX} products` },
    },

    emailVerified: { type: Boolean, default: false },
    /** SHA-256 of the emailed token; the raw token is never stored. */
    emailVerifyTokenHash: { type: String, select: false },
    emailVerifyExpires: { type: Date, select: false },

    status: { type: String, enum: USER_STATUSES, default: 'active', index: true },
    blockedReason: String,
    blockedAt: Date,
    blockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastLoginAt: Date,
  },
  { timestamps: true },
);

userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: presentString('phone') });
userSchema.index({ emailVerifyTokenHash: 1 }, { sparse: true });

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, BCRYPT_ROUNDS);
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

/** The shape of a user that is safe to send to clients and to keep in the session cache. */
userSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    _id: this._id.toString(),
    name: this.name,
    email: this.email,
    emailVerified: Boolean(this.emailVerified),
    role: this.role,
    phone: this.phone || '',
    avatar: this.avatar || '',
    addresses: this.addresses,
    wishlist: this.wishlist.map((id) => id.toString()),
    status: this.status || 'active',
    passwordChangedAt: this.passwordChangedAt,
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model('User', userSchema);
