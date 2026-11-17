import mongoose from 'mongoose';

/** Postal address fields shared by user addresses and vendor business addresses. */
export const addressFields = {
  line1: { type: String, required: true, trim: true },
  line2: { type: String, trim: true },
  city: { type: String, required: true, trim: true },
  state: { type: String, required: true, trim: true },
  pincode: { type: String, required: true, trim: true, match: /^\d{6}$/ },
  country: { type: String, default: 'India' },
};

export const addressSchema = (extra: Record<string, any> = {}, options: Record<string, any> = {}) => new mongoose.Schema({ ...extra, ...addressFields }, options);

/** Partial filter for unique-when-present string fields (empty/missing values never collide). */
export const presentString = (field) => ({ [field]: { $gt: '' } });
