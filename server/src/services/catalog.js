import { Category } from '../models/Category.js';
import { LISTED, Product } from '../models/Product.js';
import { Vendor } from '../models/Vendor.js';
import { cache } from './cache.js';
import { escapeRegex, paginated, parsePagination, round2 } from '../utils/http.js';

/**
 * Store rating = review-weighted average of its product ratings (a product with 40 reviews counts
 * more than one with 2). Runs only on review writes, using the per-product aggregates already stored.
 */
export async function recalcVendorRating(vendorId) {
  const [stats] = await Product.aggregate([
    { $match: { vendor: vendorId, numReviews: { $gt: 0 } } },
    { $group: { _id: null, weighted: { $sum: { $multiply: ['$rating', '$numReviews'] } }, count: { $sum: '$numReviews' } } },
  ]);
  const count = stats?.count || 0;
  await Vendor.updateOne({ _id: vendorId }, { rating: count ? round2(stats.weighted / count) : 0, numReviews: count });
}

export const CARD_FIELDS = 'title brand category price mrp rating numReviews sold stock thumbnail vendor createdAt';

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
  numReviews: p.numReviews,
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
    const vendorIds = await approvedVendorIds();
    const [categories, counts] = await Promise.all([
      Category.find().sort({ order: 1, name: 1 }).lean(),
      Product.aggregate([
        { $match: LISTED },
        { $match: { $expr: { $in: [{ $toString: '$vendor' }, vendorIds] } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]),
    ]);
    const byCategory = new Map(counts.map((c) => [c._id, c.count]));
    return categories.map((c) => ({ _id: c._id, name: c.name, slug: c.slug, image: c.image, group: c.group, productCount: byCategory.get(c.slug) || 0 }));
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
        pipeline: [{ $match: LISTED }, { $sort: { sold: -1 } }, { $project: { rating: 1, numReviews: 1, sold: 1, thumbnail: 1 } }],
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
            $map: { input: { $filter: { input: '$products', cond: { $gt: ['$$this.numReviews', 0] } } }, in: '$$this.rating' },
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
  const rx = q ? new RegExp(escapeRegex(q), 'i') : null;
  const match = { ...(rx ? { $or: [{ storeName: rx }, { tagline: rx }] } : {}) };
  const [result] = await Vendor.aggregate([
    { $match: { status: 'approved', ...match } },
    {
      $facet: {
        items: [...vendorStatsPipeline(), { $sort: STORE_SORTS[sort] }, { $skip: skip }, { $limit: limit }],
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
