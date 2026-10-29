import mongoose from 'mongoose';

/** Limits shared by the schema and the Zod rules in admin.controller.js. */
export const SETTINGS_LIMITS = {
  commissionRate: { min: 0, max: 50 },
  shippingFee: { min: 0, max: 1000 },
  freeShippingThreshold: { min: 0, max: 100000 },
};
export const SETTINGS_FIELDS = Object.keys(SETTINGS_LIMITS);
const HISTORY_MAX = 200;

const limited = (field, extra = {}) => ({ type: Number, ...SETTINGS_LIMITS[field], ...extra });

const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'platform', unique: true },
    /** Default commission (%) the platform keeps from every vendor sale. Orders store the rate they were charged. */
    commissionRate: limited('commissionRate', { default: 10 }),
    shippingFee: limited('shippingFee', { default: 49 }),
    /** Orders at or above this amount ship free; 0 = shipping is always free. */
    freeShippingThreshold: limited('freeShippingThreshold', { default: 999 }),
    /** Who changed which money setting, from what, to what (newest last, last 200 kept). */
    history: [
      {
        field: { type: String, enum: SETTINGS_FIELDS, required: true },
        from: Number,
        to: Number,
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: { type: Date, default: Date.now },
        _id: false,
      },
    ],
  },
  { timestamps: true },
);

settingsSchema.pre('validate', function checkThreshold() {
  if (this.freeShippingThreshold !== 0 && this.freeShippingThreshold <= this.shippingFee) {
    this.invalidate('freeShippingThreshold', 'The free-shipping threshold must be 0 (always free) or more than the shipping fee');
  }
});

/** Applies changes and records each changed field in the history. Call save() afterwards. */
settingsSchema.methods.applyChanges = function applyChanges(changes, by) {
  const at = new Date();
  for (const field of SETTINGS_FIELDS) {
    if (changes[field] === undefined || changes[field] === this[field]) continue;
    this.history.push({ field, from: this[field], to: changes[field], by, at });
    this[field] = changes[field];
  }
  if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
};

export const Settings = mongoose.model('Settings', settingsSchema);
