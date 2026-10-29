import mongoose from 'mongoose';

/** Top-level menu sections (no sub-categories). */
export const CATEGORY_GROUPS = ['Electronics', 'Fashion', 'Beauty', 'Home', 'Grocery', 'Sports', 'General'];

/** Case-insensitive, so "Laptops" and "laptops" count as the same category name. */
export const CATEGORY_NAME_COLLATION = { locale: 'en', strength: 2 };

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
    /** Tile picture on the home page grid, the promo banner and search suggestions. */
    image: { type: String, trim: true, match: [/^https?:\/\//, 'Image must be an http(s) URL'] },
    group: { type: String, enum: CATEGORY_GROUPS, default: 'General' },
    order: { type: Number, default: 0, min: 0 },
    /** Hidden categories (and their products) are not shown to shoppers. */
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

categorySchema.index({ name: 1 }, { unique: true, collation: CATEGORY_NAME_COLLATION });

export const Category = mongoose.model('Category', categorySchema);
