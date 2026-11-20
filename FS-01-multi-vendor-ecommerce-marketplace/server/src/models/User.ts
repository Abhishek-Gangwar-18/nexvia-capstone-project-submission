import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { addressSchema, presentString } from './Address.ts';

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
    /** Tokens issued before this instant are rejected (see middleware/auth.ts). */
    passwordChangedAt: Date,
    /** Stripe Customer for this user, so dashboard payments show who paid (created on first payment). */
    stripeCustomerId: { type: String, select: false },
    role: { type: String, enum: ROLES, default: 'customer', index: true },
    phone: { type: String, trim: true },
    avatar: String,
    addresses: [userAddressSchema],
    wishlist: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
      validate: { validator: (v) => v.length <= WISHLIST_MAX, message: `Wishlist can hold up to ${WISHLIST_MAX} products` },
    },

    status: { type: String, enum: USER_STATUSES, default: 'active', index: true },
    blockedReason: String,
    blockedAt: Date,
    blockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastLoginAt: Date,
  },
  { timestamps: true },
);

userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: presentString('phone') });

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, BCRYPT_ROUNDS);
});

userSchema.methods.comparePassword = function comparePassword(candidate: string) {
  return bcrypt.compare(candidate, this.password);
};

/** The shape of a user that is safe to send to clients and to keep in the session cache. */
userSchema.methods.toSafeJSON = function toSafeJSON(): SafeUser {
  return {
    _id: this._id.toString(),
    name: this.name,
    email: this.email,
    role: this.role,
    phone: this.phone || '',
    avatar: this.avatar || '',
    addresses: this.addresses,
    wishlist: this.wishlist.map((id) => id.toString()),
    status: this.status || 'active',
    ...(this.status === 'blocked' && { blockedReason: this.blockedReason, blockedAt: this.blockedAt }),
    passwordChangedAt: this.passwordChangedAt,
    createdAt: this.createdAt,
  };
};

export interface UserMethods {
  comparePassword(candidate: string): Promise<boolean>;
  toSafeJSON(): SafeUser;
}
/** The user object kept in the session cache and set as `req.user`. */
export type SafeUser = {
  _id: string;
  name: string;
  email: string;
  role: 'customer' | 'vendor' | 'admin';
  phone: string;
  avatar: string;
  addresses: any[];
  wishlist: string[];
  status: string;
  blockedReason?: string;
  blockedAt?: Date;
  passwordChangedAt?: Date;
  createdAt?: Date;
};
type UserRaw = Omit<mongoose.InferSchemaType<typeof userSchema>, 'addresses' | 'wishlist'> & {
  addresses: mongoose.Types.DocumentArray<mongoose.Types.Subdocument & Record<string, any>>;
  /** Product ids; populated to products on the wishlist page. */
  wishlist: mongoose.Types.Array<any>;
};

export const User = mongoose.model<UserRaw, mongoose.Model<UserRaw, {}, UserMethods>>('User', userSchema);
export type UserDocument = mongoose.HydratedDocument<UserRaw, UserMethods>;
