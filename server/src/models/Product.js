import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true },
    description: { type: String, default: '' },
    brand: { type: String, default: 'Generic', trim: true },
    category: { type: String, required: true, index: true },
    price: { type: Number, required: true, min: 1 },
    mrp: { type: Number, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    sku: { type: String, trim: true },
    images: [{ url: { type: String, required: true }, key: String, _id: false }],
    thumbnail: String,
    tags: [{ type: String, trim: true }],
    specs: [{ label: String, value: String, _id: false }],
    rating: { type: Number, default: 0 },
    numReviews: { type: Number, default: 0 },
    sold: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
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

export const Product = mongoose.model('Product', productSchema);
