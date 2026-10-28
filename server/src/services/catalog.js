import { Category } from '../models/Category.js';
import { Product } from '../models/Product.js';
import { Vendor } from '../models/Vendor.js';
import { cache } from './cache.js';

export const CARD_FIELDS = 'title slug brand category price mrp rating numReviews sold stock thumbnail vendor createdAt';

/** Flattens a product (with populated vendor) into the shape product cards use. */
export const toCard = (p) => ({
  _id: p._id,
  title: p.title,
  slug: p.slug,
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
  storeSlug: p.vendor?.slug,
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
        { $match: { isActive: true } },
        { $match: { $expr: { $in: [{ $toString: '$vendor' }, vendorIds] } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]),
    ]);
    const byCategory = new Map(counts.map((c) => [c._id, c.count]));
    return categories.map((c) => ({ _id: c._id, name: c.name, slug: c.slug, image: c.image, group: c.group, productCount: byCategory.get(c.slug) || 0 }));
  });
}

/** Approved stores ranked by units sold, with headline stats and a few product previews. */
export async function rankedVendors(limit = 12) {
  return Vendor.aggregate([
    { $match: { status: 'approved' } },
    {
      $lookup: {
        from: 'products',
        localField: '_id',
        foreignField: 'vendor',
        as: 'products',
        pipeline: [{ $match: { isActive: true } }, { $sort: { sold: -1 } }, { $project: { rating: 1, numReviews: 1, sold: 1, thumbnail: 1 } }],
      },
    },
    {
      $project: {
        storeName: 1,
        slug: 1,
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
    { $sort: { sold: -1 } },
    { $limit: limit },
  ]);
}

/** Drops cached product pages and listings that include the given products. */
export async function invalidateProducts(products = []) {
  const keys = products.flatMap((p) => [`product:${p._id || p.product || p}`, p.slug ? `product:${p.slug}` : null]);
  await cache.del(...keys);
  await cache.delPattern('home:*');
}

export async function invalidateCatalog() {
  await Promise.all([cache.delPattern('home:*'), cache.delPattern('store:*'), cache.del('categories', 'vendors:approved')]);
}
