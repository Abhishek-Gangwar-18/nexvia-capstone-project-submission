import mongoose from 'mongoose';
import { addressSchema, presentString } from './Address.js';
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
    /** Display-only bank details for manual settlement (vendors paid outside Stripe). Stripe keeps its own. */
    bank: {
      accountHolder: String,
      accountNumberMasked: String,
      ifsc: { type: String, uppercase: true },
    },
    /**
     * Stripe Connect Express account that receives payouts. Bank details live in Stripe, never here;
     * the flags are refreshed from Stripe (account.updated webhook, or the vendor reopening the page).
     */
    stripe: {
      accountId: { type: String, trim: true },
      detailsSubmitted: { type: Boolean, default: false },
      chargesEnabled: { type: Boolean, default: false },
      payoutsEnabled: { type: Boolean, default: false },
      syncedAt: Date,
    },
    /**
     * Payouts are frozen while active: set when the payout destination changes while money is still
     * waiting to be paid out, cleared by an admin. The payout job skips the vendor meanwhile.
     */
    payoutHold: {
      active: { type: Boolean, default: false },
      reason: String,
      since: Date,
      clearedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      clearedAt: Date,
    },
    status: { type: String, enum: VENDOR_STATUSES, default: 'pending', index: true },
    /** Latest reason shown to the seller (rejection / suspension). */
    rejectionReason: String,
    /** Audit trail of payout destination changes (bank / linked account). Interim guard until the payments redesign. */
    payoutChanges: [
      {
        fields: [String],
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: { type: Date, default: Date.now },
        ip: String,
        _id: false,
      },
    ],
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
    /** Average of all ratings on the store's products, kept in sync with $inc on every rating write. */
    rating: { type: Number, default: 0 },
    ratingSum: { type: Number, default: 0 },
    numRatings: { type: Number, default: 0 },
    approvedAt: Date,
  },
  { timestamps: true },
);

vendorSchema.index({ storeName: 1 }, { unique: true, collation: STORE_NAME_COLLATION });
vendorSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: presentString('phone') });

/**
 * Status moves an admin can make. rejected -> pending happens only when the seller resubmits
 * (vendor.controller updateStore), never from the admin panel.
 */
export const VENDOR_TRANSITIONS = {
  pending: ['approved', 'rejected'],
  approved: ['suspended'],
  suspended: ['approved'],
  rejected: [],
};

/** History reason used when a store is suspended because its owner's account was blocked. */
export const OWNER_BLOCKED = 'Owner account blocked';

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
