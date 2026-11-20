import mongoose from 'mongoose';

export const MAX_PER_ITEM = 10;
export const MAX_LINES = 50;

const lineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    /** What the customer asked for; reads cap it to live stock without overwriting it. */
    quantity: { type: Number, required: true, min: 1, max: MAX_PER_ITEM, validate: Number.isInteger },
    /** Price when first added, so the cart can show a price rise/drop. Checkout always uses the live price. */
    priceAtAdd: { type: Number, min: 0 },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/** Durable copy of a customer's cart; Redis caches reads (see services/cart.ts). */
const cartSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    items: {
      type: [lineSchema],
      validate: [
        { validator: (v) => v.length <= MAX_LINES, message: `A cart can hold up to ${MAX_LINES} products` },
        { validator: (v) => new Set(v.map((l) => String(l.product))).size === v.length, message: 'A product can appear only once in a cart' },
      ],
    },
  },
  { timestamps: true },
);

export const Cart = mongoose.model('Cart', cartSchema);
