/**
 * One-off migration for the User/Vendor schema review (run once per database):
 *   pnpm migrate:v2
 *
 * - users:   isBlocked -> status ('active' | 'blocked'); existing accounts are grandfathered as emailVerified;
 *            empty phones are removed so the new unique phone index can build.
 * - vendors: seeds statusHistory from the current status; recomputes rating/numReviews.
 * - slugs:   removes product/vendor/order-item slugs (URLs use ids).
 * - indexes: syncs User, Vendor and Product indexes (unique storeName / phone / per-vendor sku). Fails loudly on duplicates.
 *
 * Safe to re-run: every step only touches documents that still need it.
 */
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { User } from '../src/models/User.js';
import { STORE_NAME_COLLATION, Vendor } from '../src/models/Vendor.js';
import { Product } from '../src/models/Product.js';
import { recalcVendorRating } from '../src/services/catalog.js';

const users = User.collection;
const vendors = Vendor.collection;

async function findDuplicates(collection, field, collation) {
  return collection
    .aggregate(
      [
        { $match: { [field]: { $gt: '' } } },
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
      ],
      collation ? { collation } : {},
    )
    .toArray();
}

try {
  await connectDB();

  const blocked = await users.updateMany({ isBlocked: true }, { $set: { status: 'blocked', blockedAt: new Date() }, $unset: { isBlocked: '' } });
  const active = await users.updateMany({ status: { $exists: false } }, { $set: { status: 'active' }, $unset: { isBlocked: '' } });
  const verified = await users.updateMany({ emailVerified: { $exists: false } }, { $set: { emailVerified: true } });
  const phones = await users.updateMany({ phone: '' }, { $unset: { phone: '' } });
  console.log(`users: ${blocked.modifiedCount} blocked, ${active.modifiedCount} active, ${verified.modifiedCount} grandfathered verified, ${phones.modifiedCount} empty phones removed`);

  const history = await vendors.updateMany({ statusHistory: { $exists: false } }, [
    { $set: { statusHistory: [{ status: '$status', reason: 'Migrated', at: { $ifNull: ['$approvedAt', '$createdAt'] } }] } },
  ]);
  console.log(`vendors: statusHistory seeded on ${history.modifiedCount}`);

  // Product/store URLs use ids now; slugs are gone (syncIndexes below drops the old slug_1 indexes).
  const slugs = await Promise.all([
    Product.collection.updateMany({ slug: { $exists: true } }, { $unset: { slug: '' } }),
    vendors.updateMany({ slug: { $exists: true } }, { $unset: { slug: '' } }),
    mongoose.connection.collection('orders').updateMany({ 'packages.items.slug': { $exists: true } }, { $unset: { 'packages.$[].items.$[].slug': '' } }),
  ]);
  const [productSlugs, vendorSlugs, orderSlugs] = slugs.map((r) => r.modifiedCount);
  console.log(`slugs removed: ${productSlugs} products, ${vendorSlugs} vendors, ${orderSlugs} orders`);

  const ids = await vendors.distinct('_id');
  for (const id of ids) await recalcVendorRating(id);
  console.log(`vendors: rating recomputed for ${ids.length}`);

  const dupes = {
    'users.phone': await findDuplicates(users, 'phone'),
    'vendors.storeName': await findDuplicates(vendors, 'storeName', STORE_NAME_COLLATION),
    'vendors.phone': await findDuplicates(vendors, 'phone'),
    'products.vendor+sku': await Product.collection
      .aggregate([{ $match: { sku: { $gt: '' } } }, { $group: { _id: { vendor: '$vendor', sku: '$sku' }, count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }])
      .toArray(),
  };
  const clashes = Object.entries(dupes).filter(([, list]) => list.length);
  if (clashes.length) {
    clashes.forEach(([field, list]) => console.error(`duplicate ${field}:`, list.map((d) => `${JSON.stringify(d._id)} (x${d.count})`).join(', ')));
    throw new Error('Resolve the duplicates above, then re-run to build the unique indexes');
  }

  await User.syncIndexes();
  await Vendor.syncIndexes();
  await Product.syncIndexes();
  console.log('indexes: User, Vendor and Product indexes in sync');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
