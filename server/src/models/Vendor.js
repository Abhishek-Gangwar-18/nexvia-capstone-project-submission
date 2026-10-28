import mongoose from 'mongoose';
import { addressSchema, presentString } from './address.js';
import { GSTIN_REGEX } from '../utils/validators.js';

export const VENDOR_STATUSES = ['pending', 'approved', 'rejected', 'suspended'];

/** Case-insensitive comparison, so "TechHub" and "techhub" count as the same store name. */
export const STORE_NAME_COLLATION = { locale: 'en', strength: 2 };

const vendorSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    storeName: { type: String, required: true, trim: true },
    tagline: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    logo: String,
    banner: String,
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    gstin: { type: String, trim: true, uppercase: true, match: [GSTIN_REGEX, 'Invalid GSTIN'] },
    address: addressSchema({}, { _id: false }),
    /** Display-only; the real bank details live with Razorpay (Route linked account). */
    bank: {
      accountHolder: String,
      accountNumberMasked: String,
      ifsc: { type: String, uppercase: true },
    },
    /** Razorpay Route linked account id (acc_XXXX) used for split payments. */
    razorpayAccountId: { type: String, trim: true },
    status: { type: String, enum: VENDOR_STATUSES, default: 'pending', index: true },
    /** Latest reason shown to the seller (rejection / suspension). */
    rejectionReason: String,
    statusHistory: [
      {
        status: { type: String, enum: VENDOR_STATUSES, required: true },
        reason: String,
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: { type: Date, default: Date.now },
        _id: false,
      },
    ],
    /** Per-vendor commission override (%). Falls back to the platform rate when null. */
    commissionRate: { type: Number, min: 0, max: 50, default: null },
    /** Review-weighted average of the store's product ratings; recomputed on every review write. */
    rating: { type: Number, default: 0 },
    numReviews: { type: Number, default: 0 },
    approvedAt: Date,
  },
  { timestamps: true },
);

vendorSchema.index({ storeName: 1 }, { unique: true, collation: STORE_NAME_COLLATION });
vendorSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: presentString('phone') });

/** Records a status change in the history (call before save). */
vendorSchema.methods.setStatus = function setStatus(status, { reason, by } = {}) {
  this.status = status;
  this.statusHistory.push({ status, reason, by });
  if (status === 'approved') {
    this.approvedAt = new Date();
    this.rejectionReason = undefined;
  } else if (reason) {
    this.rejectionReason = reason;
  }
};

export const Vendor = mongoose.model('Vendor', vendorSchema);
