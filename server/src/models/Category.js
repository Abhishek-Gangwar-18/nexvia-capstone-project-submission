import mongoose from 'mongoose';

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true },
    image: String,
    group: { type: String, default: 'General' },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const Category = mongoose.model('Category', categorySchema);
