import mongoose from 'mongoose';
import { Category } from './Category.js';
import { presentString } from './address.js';

/** Field limits, shared with the Zod rules in vendor.controller.js. */
export const PRODUCT_LIMITS = { title: 100, description: 500, images: 8, tags: 20, specs: 10 };
export const MODERATION_STATUSES = ['approved', 'removed'];

const maxItems = (max, label) => ({ validator: (v) => v.length <= max, message: `Up to ${max} ${label} allowed` });

const productSchema = new mongoose.Schema(
  {
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: PRODUCT_LIMITS.title },
    description: { type: String, default: '', maxlength: PRODUCT_LIMITS.description },
    brand: { type: String, default: 'Generic', trim: true },
    /** Category.slug - checked against the categories collection on every write. */
    category: {
      type: String,
      required: true,
      index: true,
      validate: { validator: async (slug) => Boolean(await Category.exists({ slug })), message: 'Unknown category' },
    },
    price: { type: Number, required: true, min: 1, set: (v) => Math.round(v * 100) / 100 },
    mrp: { type: Number, min: 0, set: (v) => (v == null ? v : Math.round(v * 100) / 100) },
    stock: { type: Number, default: 0, min: 0 },
    sku: { type: String, trim: true },
    images: { type: [{ url: { type: String, required: true }, key: String, _id: false }], validate: maxItems(PRODUCT_LIMITS.images, 'images') },
    thumbnail: String,
    tags: { type: [{ type: String, trim: true }], validate: maxItems(PRODUCT_LIMITS.tags, 'tags') },
    specs: { type: [{ label: String, value: String, _id: false }], validate: maxItems(PRODUCT_LIMITS.specs, 'specs') },
    rating: { type: Number, default: 0 },
    numReviews: { type: Number, default: 0 },
    sold: { type: Number, default: 0 },
    /** Seller's own switch: listed / hidden. */
    isActive: { type: Boolean, default: true, index: true },
    /** Platform's decision, independent of isActive: a removed product stays hidden whatever the seller sets. */
    moderation: {
      status: { type: String, enum: MODERATION_STATUSES, default: 'approved' },
      reason: String,
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date,
    },
  },
  { timestamps: true },
);

productSchema.pre('validate', function syncDerivedFields() {
  if (!this.mrp || this.mrp < this.price) this.mrp = this.price;
  const firstImage = this.images?.[0]?.url;
  if (!firstImage) return;
  // Keep an explicitly provided thumbnail on create; afterwards it follows the first image.
  if (this.isNew ? !this.thumbnail : this.isModified('images')) this.thumbnail = firstImage;
});

productSchema.index({ category: 1, sold: -1 });
productSchema.index({ createdAt: -1 });
productSchema.index({ vendor: 1, createdAt: -1 });
productSchema.index({ isActive: 1, category: 1, price: 1 });
productSchema.index({ vendor: 1, sku: 1 }, { unique: true, partialFilterExpression: presentString('sku') });

/** Query filter for products shoppers may see (vendor approval is checked separately). */
export const LISTED = { isActive: true, 'moderation.status': { $ne: 'removed' } };
export const isListed = (p) => Boolean(p?.isActive) && p?.moderation?.status !== 'removed';

export const Product = mongoose.model('Product', productSchema);
