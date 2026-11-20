import mongoose from 'mongoose';
import { Category } from './Category.ts';
import { presentString } from './Address.ts';

/** Field limits, shared with the Zod rules in vendor.controller.ts. */
export const PRODUCT_LIMITS = { title: 100, description: 500, images: 8, tags: 20, specs: 10 };
export const MODERATION_STATUSES = ['approved', 'removed'];

const maxItems = (max, label) => ({ validator: (v) => v.length <= max, message: `Up to ${max} ${label} allowed` });

const productSchema = new mongoose.Schema(
  {
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: PRODUCT_LIMITS.title },
    description: { type: String, default: '', maxlength: PRODUCT_LIMITS.description },
    brand: { type: String, default: 'Generic', trim: true },
    /** Checked against the categories collection on every write. */
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
      index: true,
      validate: { validator: async (id) => Boolean(await Category.exists({ _id: id })), message: 'Unknown category' },
    },
    /** Set while the product's category is hidden or deleted by an admin (kept in sync by the category admin API). */
    categoryHidden: { type: Boolean, default: false },
    price: { type: Number, required: true, min: 1, set: (v) => Math.round(v * 100) / 100 },
    mrp: { type: Number, min: 0, set: (v) => (v == null ? v : Math.round(v * 100) / 100) },
    stock: { type: Number, default: 0, min: 0 },
    sku: { type: String, trim: true },
    images: { type: [{ url: { type: String, required: true }, key: String, _id: false }], validate: maxItems(PRODUCT_LIMITS.images, 'images') },
    thumbnail: String,
    tags: { type: [{ type: String, trim: true }], validate: maxItems(PRODUCT_LIMITS.tags, 'tags') },
    specs: { type: [{ label: String, value: String, _id: false }], validate: maxItems(PRODUCT_LIMITS.specs, 'specs') },
    /** Average of the Rating documents (ratingSum / numRatings), kept in sync with $inc on every rating write. */
    rating: { type: Number, default: 0 },
    ratingSum: { type: Number, default: 0 },
    numRatings: { type: Number, default: 0 },
    sold: { type: Number, default: 0 },
    /** Seller's own switch: listed / hidden. */
    isActive: { type: Boolean, default: true, index: true },
    /** Bumped by every seller edit (not by sales), so a save from an outdated form is refused instead of overwriting. */
    editVersion: { type: Number, default: 0 },
    /** Soft delete by the seller: hidden from shoppers and the seller's lists, still visible to admins. */
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
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
export const LISTED = { isActive: true, deletedAt: null, categoryHidden: { $ne: true }, 'moderation.status': { $ne: 'removed' } };
export const isListed = (p) => Boolean(p?.isActive) && !p?.deletedAt && !p?.categoryHidden && p?.moderation?.status !== 'removed';

export const Product = mongoose.model('Product', productSchema);
