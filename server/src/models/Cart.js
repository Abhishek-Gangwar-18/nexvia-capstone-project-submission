import mongoose from 'mongoose';

/** Durable copy of a customer's cart. Reads are served from Redis; this is the write-through backing store. */
const cartSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    items: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
        quantity: { type: Number, required: true, min: 1 },
        _id: false,
      },
    ],
  },
  { timestamps: true },
);

export const Cart = mongoose.model('Cart', cartSchema);
