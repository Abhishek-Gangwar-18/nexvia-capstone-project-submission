import { EventEmitter } from 'node:events';
import { Product } from '../models/Product.ts';
import { Coupon } from '../models/Coupon.ts';
import { Vendor } from '../models/Vendor.ts';
import { supportsTransactions } from '../config/db.ts';
import { cache } from './cache.ts';
import { logger } from '../utils/logger.ts';

/**
 * Live product changes for open carts. A MongoDB change stream reports every write that changes what
 * a cart shows (stock, price, MRP, listing state), whichever code path made it: vendor edits, other
 * customers' orders reserving stock, cancellations restocking, admin moderation. Each change is
 * emitted as 'change' with the product id; GET /cart/events forwards it to connected customers.
 * Coupon edits (switched off, expired, value or limits changed, deleted) are emitted as 'coupon', so an
 * applied coupon is re-checked at once instead of staying on screen until a reload.
 * Change streams need a replica set (Atlas is one); on a standalone server carts fall back to refetching.
 */
export const productEvents = new EventEmitter();
productEvents.setMaxListeners(0); // one listener per open customer connection

const WATCHED = ['stock', 'price', 'mrp', 'isActive', 'deletedAt', 'moderation', 'moderation.status'];
let stream = null;

export function watchProducts() {
  if (stream) return;
  if (!supportsTransactions()) {
    logger.info('Live cart updates: off (needs a MongoDB replica set) -> carts refresh on focus/open instead');
    return;
  }
  const pipeline = [
    {
      $match: {
        $or: [
          { operationType: { $in: ['delete', 'replace'] } },
          ...WATCHED.map((f) => ({ [`updateDescription.updatedFields.${f}`]: { $exists: true } })),
        ],
      },
    },
    { $project: { documentKey: 1 } },
  ];
  const open = () => {
    stream = Product.watch(pipeline);
    stream.on('change', (change) => {
      const id = String(change.documentKey._id);
      // Drop the cached product page too, so stock/price shown on it are never older than this write
      // (order reservations and restocks change stock without going through the product controllers).
      cache.del(`product:${id}`).catch(() => {});
      productEvents.emit('change', id);
    });
    stream.on('error', (err) => {
      logger.warn(`Live cart updates: change stream error (${err.message}) -> reconnecting in 5s`);
      stream?.close().catch(() => {});
      stream = null;
      setTimeout(open, 5000).unref();
    });
  };
  open();
  logger.info('Live cart updates: watching product stock and price changes');
}

let couponStream = null;

/** Any coupon write: the client re-validates its applied coupon (cheap, and covers deletes too). */
export function watchCoupons() {
  if (couponStream || !supportsTransactions()) return;
  const open = () => {
    couponStream = Coupon.watch([{ $match: { operationType: { $in: ['update', 'replace', 'delete'] } } }, { $project: { documentKey: 1 } }]);
    couponStream.on('change', (change) => productEvents.emit('coupon', String(change.documentKey._id)));
    couponStream.on('error', (err) => {
      logger.warn(`Live coupon updates: change stream error (${err.message}) -> reconnecting in 5s`);
      couponStream?.close().catch(() => {});
      couponStream = null;
      setTimeout(open, 5000).unref();
    });
  };
  open();
}

let vendorStream = null;

/** A store's status changed (suspended, re-approved): its products appear in or leave carts. */
export function watchVendors() {
  if (vendorStream || !supportsTransactions()) return;
  const open = () => {
    vendorStream = Vendor.watch([{ $match: { 'updateDescription.updatedFields.status': { $exists: true } } }, { $project: { documentKey: 1 } }]);
    vendorStream.on('change', async (change) => {
      const ids = await Product.find({ vendor: change.documentKey._id }).distinct('_id').catch(() => []);
      await cache.del(...ids.map((id) => `product:${id}`)).catch(() => {});
      ids.forEach((id) => productEvents.emit('change', String(id)));
    });
    vendorStream.on('error', (err) => {
      logger.warn(`Live store updates: change stream error (${err.message}) -> reconnecting in 5s`);
      vendorStream?.close().catch(() => {});
      vendorStream = null;
      setTimeout(open, 5000).unref();
    });
  };
  open();
}
