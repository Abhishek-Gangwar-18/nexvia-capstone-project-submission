import mongoose from 'mongoose';

export const VENDOR_STATUSES = ['pending', 'approved', 'rejected', 'suspended'];

const vendorSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    storeName: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true },
    tagline: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    logo: String,
    banner: String,
    email: { type: String, trim: true },
    phone: { type: String, trim: true },
    gstin: { type: String, trim: true, uppercase: true },
    address: {
      line1: String,
      city: String,
      state: String,
      pincode: String,
    },
    bank: {
      accountHolder: String,
      accountNumberMasked: String,
      ifsc: { type: String, uppercase: true },
    },
    /** Razorpay Route linked account id (acc_XXXX) used for split payments. */
    razorpayAccountId: { type: String, trim: true },
    status: { type: String, enum: VENDOR_STATUSES, default: 'pending', index: true },
    rejectionReason: String,
    /** Per-vendor commission override (%). Falls back to the platform rate when null. */
    commissionRate: { type: Number, min: 0, max: 50, default: null },
    rating: { type: Number, default: 0 },
    approvedAt: Date,
  },
  { timestamps: true },
);

export const Vendor = mongoose.model('Vendor', vendorSchema);
