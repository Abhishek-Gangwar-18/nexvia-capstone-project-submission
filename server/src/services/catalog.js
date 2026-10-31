import mongoose from 'mongoose';
import { searchEntityIds, toObjectIds } from './entitySearch.js';
import { Category } from '../models/Category.js';
import { LISTED, Product } from '../models/Product.js';
import { Vendor } from '../models/Vendor.js';
import { cache } from './cache.js';
import { escapeRegex, paginated, parsePagination, round2 } from '../utils/http.js';

/**
 * Recounts a store's rating from its products' rating totals. Rating writes keep it current with $inc
 * (services/reviews.js); this full recount is for repairs and migrations.
 */
export async function recalcVendorRating(vendorId) {
  const [stats] = await Product.aggregate([
    { $match: { vendor: vendorId } },
    { $group: { _id: null, sum: { $sum: '$ratingSum' }, count: { $sum: '$numRatings' } } },
  ]);
  const count = stats?.count || 0;
  const sum = stats?.sum || 0;
  await Vendor.updateOne({ _id: vendorId }, { ratingSum: sum, numRatings: count, rating: count ? round2(sum / count) : 0 });
}

export const CARD_FIELDS = 'title brand category price mrp rating numRatings sold stock thumbnail vendor createdAt';

/** Flattens a product (with populated vendor) into the shape product cards use. */
export const toCard = (p) => ({
  _id: p._id,
  title: p.title,
  brand: p.brand,
  category: p.category,
  price: p.price,
  mrp: p.mrp,
  discount: p.mrp > p.price ? Math.round(((p.mrp - p.price) / p.mrp) * 100) : 0,
  rating: p.rating,
  numRatings: p.numRatings,
  sold: p.sold,
  stock: p.stock,
  thumbnail: p.thumbnail,
  createdAt: p.createdAt,
  vendorId: p.vendor?._id || p.vendor,
  storeName: p.vendor?.storeName,
});

export async function approvedVendorIds() {
  return cache.remember('vendors:approved', 120, async () => (await Vendor.find({ status: 'approved' }).distinct('_id')).map(String));
}

export async function categoriesWithCounts() {
  return cache.remember('categories', 600, async () => {
    const vendorIds = (await approvedVendorIds()).map((id) => new mongoose.Types.ObjectId(id));
    const [categories, counts] = await Promise.all([
      Category.find({ isActive: true }).sort({ order: 1, name: 1 }).lean(),
      // Plain $in on the ObjectIds (no per-document $toString), so the vendor index can be used.
      Product.aggregate([{ $match: { ...LISTED, vendor: { $in: vendorIds } } }, { $group: { _id: '$category', count: { $sum: 1 } } }]),
    ]);
    const byCategory = new Map(counts.map((c) => [String(c._id), c.count]));
    return categories.map((c) => ({ _id: c._id, name: c.name, image: c.image, group: c.group, productCount: byCategory.get(String(c._id)) || 0 }));
  });
}

/** Approved stores ranked by units sold, with headline stats and a few product previews. */
const STORE_SORTS = {
  popular: { sold: -1, _id: 1 },
  rating: { rating: -1, sold: -1, _id: 1 },
  newest: { createdAt: -1, _id: 1 },
  products: { productCount: -1, _id: 1 },
};

/** Approved stores with their product stats (count, units sold, average rating, preview thumbnails). */
function vendorStatsPipeline(match = {}) {
  return [
    { $match: { status: 'approved', ...match } },
    {
      $lookup: {
        from: 'products',
        localField: '_id',
        foreignField: 'vendor',
        as: 'products',
        pipeline: [{ $match: LISTED }, { $sort: { sold: -1 } }, { $project: { rating: 1, numRatings: 1, sold: 1, thumbnail: 1 } }],
      },
    },
    {
      $project: {
        storeName: 1,
        logo: 1,
        banner: 1,
        tagline: 1,
        createdAt: 1,
        productCount: { $size: '$products' },
        sold: { $sum: '$products.sold' },
        rating: {
          $avg: {
            $map: { input: { $filter: { input: '$products', cond: { $gt: ['$$this.numRatings', 0] } } }, in: '$$this.rating' },
          },
        },
        previews: { $slice: ['$products.thumbnail', 4] },
      },
    },
  ];
}

export async function rankedVendors(limit = 12) {
  return Vendor.aggregate([...vendorStatsPipeline(), { $sort: STORE_SORTS.popular }, { $limit: limit }]);
}

/** GET /stores query: ?q= (store name/tagline), ?sort=popular|rating|newest|products, ?page, ?limit (max 48). */
export function storeListParams(query) {
  const { page, limit, skip } = parsePagination(query, { defaultLimit: 24, maxLimit: 48 });
  return {
    q: String(query.q || '').trim().slice(0, 60),
    sort: STORE_SORTS[query.sort] ? query.sort : 'popular',
    page,
    limit,
    skip,
  };
}

export async function listVendors({ q, sort, page, limit, skip }) {
  // Elasticsearch (typo tolerant, best match first); MongoDB text match while it is unavailable.
  const hits = q ? await searchEntityIds('vendors', q, { publicOnly: true }) : null;
  const rx = q && !hits ? new RegExp(escapeRegex(q), 'i') : null;
  const match = hits ? { _id: { $in: toObjectIds(hits) } } : rx ? { $or: [{ storeName: rx }, { tagline: rx }] } : {};
  // Searching with the default sort: best match first.
  const order = hits && sort === 'popular' ? { _rank: 1 } : STORE_SORTS[sort];
  const [result] = await Vendor.aggregate([
    { $match: { status: 'approved', ...match } },
    ...(hits ? [{ $set: { _rank: { $indexOfArray: [toObjectIds(hits), '$_id'] } } }] : []),
    {
      $facet: {
        items: [...vendorStatsPipeline(), { $sort: order }, { $skip: skip }, { $limit: limit }],
        total: [{ $count: 'n' }],
      },
    },
  ]);
  return paginated(result.items, result.total[0]?.n || 0, page, limit);
}

/** Drops cached product pages and listings that include the given products. */
export async function invalidateProducts(products = []) {
  const keys = products.map((p) => `product:${p._id || p.product || p}`);
  await cache.del(...keys);
  await cache.delPattern('home:*');
}

export async function invalidateCatalog() {
  await Promise.all([cache.delPattern('home:*'), cache.delPattern('store:*'), cache.del('categories', 'vendors:approved')]);
}
