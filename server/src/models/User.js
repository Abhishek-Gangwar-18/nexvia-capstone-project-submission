import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

export const ROLES = ['customer', 'vendor', 'admin'];

const addressSchema = new mongoose.Schema({
  label: { type: String, default: 'Home', trim: true },
  fullName: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  line1: { type: String, required: true, trim: true },
  line2: { type: String, trim: true },
  city: { type: String, required: true, trim: true },
  state: { type: String, required: true, trim: true },
  pincode: { type: String, required: true, trim: true },
  country: { type: String, default: 'India' },
  isDefault: { type: Boolean, default: false },
});

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6, select: false },
    role: { type: String, enum: ROLES, default: 'customer', index: true },
    phone: { type: String, trim: true },
    avatar: String,
    addresses: [addressSchema],
    wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    isBlocked: { type: Boolean, default: false },
    lastLoginAt: Date,
  },
  { timestamps: true },
);

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
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
    role: this.role,
    phone: this.phone || '',
    avatar: this.avatar || '',
    addresses: this.addresses,
    wishlist: this.wishlist.map((id) => id.toString()),
    isBlocked: this.isBlocked,
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model('User', userSchema);
