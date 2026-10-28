import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'platform', unique: true },
    /** Default commission (%) the platform keeps from every vendor sale. */
    commissionRate: { type: Number, default: 10, min: 0, max: 50 },
    shippingFee: { type: Number, default: 49, min: 0 },
    freeShippingThreshold: { type: Number, default: 999, min: 0 },
  },
  { timestamps: true },
);

export const Settings = mongoose.model('Settings', settingsSchema);
