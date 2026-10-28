import mongoose from 'mongoose';
import { z } from 'zod';
import { isListed, LISTED, Product } from '../models/Product.js';
import { Category } from '../models/Category.js';
import { Review } from '../models/Review.js';
import { Order } from '../models/Order.js';
import { Vendor } from '../models/Vendor.js';
import { Coupon } from '../models/Coupon.js';
import { cache } from '../services/cache.js';
import { searchProducts, suggest, indexProducts } from '../services/search.js';
import { approvedVendorIds, CARD_FIELDS, recalcVendorRating, categoriesWithCounts, invalidateProducts, listVendors, rankedVendors, storeListParams, toCard } from '../services/catalog.js';
import { uploadFile } from '../services/storage.js';
import { ApiError, paginated, parsePagination, round2 } from '../utils/http.js';

/* --------------------------------------------------------------- browse */

export async function listCategories(_req, res) {
  res.json({ categories: await categoriesWithCounts() });
}

export async function listProducts(req, res) {
  res.json(await searchProducts(req.query));
}

export async function suggestProducts(req, res) {
  res.json(await suggest(req.query.q));
}

export async function home(_req, res) {
  const feed = await cache.remember('home:feed', 120, async () => {
    const vendorIds = (await approvedVendorIds()).map((id) => new mongoose.Types.ObjectId(id));
    const base = { ...LISTED, vendor: { $in: vendorIds } };
    const cards = (query) => query.select(CARD_FIELDS).populate('vendor', 'storeName').lean().then((list) => list.map(toCard));

    const [categories, trending, topRated, newArrivals, dealIds, vendors] = await Promise.all([
      categoriesWithCounts(),
      cards(Product.find(base).sort({ sold: -1 }).limit(12)),
      cards(Product.find({ ...base, numReviews: { $gte: 3 } }).sort({ rating: -1, numReviews: -1 }).limit(12)),
      cards(Product.find(base).sort({ createdAt: -1 }).limit(12)),
      Product.aggregate([
        { $match: { ...base, stock: { $gt: 0 } } },
        { $set: { off: { $cond: [{ $gt: ['$mrp', '$price'] }, { $divide: [{ $subtract: ['$mrp', '$price'] }, '$mrp'] }, 0] } } },
        { $sort: { off: -1, sold: -1 } },
        { $limit: 12 },
        { $project: { _id: 1 } },
      ]),
      rankedVendors(8),
    ]);
    const deals = await cards(Product.find({ _id: { $in: dealIds.map((d) => d._id) } }));
    deals.sort((a, b) => b.discount - a.discount);
    return { categories, trending, topRated, newArrivals, deals, vendors };
  });
  res.json(feed);
}

export async function getProduct(req, res) {
  const { productId } = req.params;
  if (!mongoose.isValidObjectId(productId)) throw new ApiError(400, 'Invalid product id');
  const data = await cache.remember(`product:${productId}`, 300, async () => {
    const product = await Product.findById(productId).populate('vendor', 'user storeName logo tagline status createdAt').lean();
    if (!product) return null;
    const [related, category, storeStats] = await Promise.all([
      Product.find({ category: product.category, _id: { $ne: product._id }, ...LISTED })
        .sort({ sold: -1 })
        .limit(10)
        .select(CARD_FIELDS)
        .populate('vendor', 'storeName')
        .lean(),
      Category.findOne({ slug: product.category }).select('name slug').lean(),
      Product.aggregate([
        { $match: { vendor: product.vendor._id, ...LISTED } },
        { $group: { _id: null, products: { $sum: 1 }, sold: { $sum: '$sold' }, rating: { $avg: { $cond: [{ $gt: ['$numReviews', 0] }, '$rating', null] } } } },
      ]),
    ]);
    return {
      product,
      related: related.map(toCard),
      category,
      store: { ...storeStats[0], rating: round2(storeStats[0]?.rating || 0) },
    };
  });

  const isOwner = req.user && (req.user.role === 'admin' || String(data?.product.vendor?.user) === req.user._id);
  const publiclyVisible = data && isListed(data.product) && data.product.vendor?.status === 'approved';
  if (!data || (!publiclyVisible && !isOwner)) throw new ApiError(404, 'Product not found');

  const { user: _vendorUser, ...vendor } = data.product.vendor;
  res.json({ ...data, product: { ...data.product, vendor } });
}

/* --------------------------------------------------------------- stores */

export async function listStores(req, res) {
  const params = storeListParams(req.query);
  const key = `store:list:${params.q}:${params.sort}:${params.page}:${params.limit}`;
  res.json(await cache.remember(key, 300, () => listVendors(params)));
}

export async function getStore(req, res) {
  const { storeId } = req.params;
  if (!mongoose.isValidObjectId(storeId)) throw new ApiError(400, 'Invalid store id');
  const store = await cache.remember(`store:${storeId}`, 300, async () => {
    const vendor = await Vendor.findOne({ _id: storeId, status: 'approved' })
      .select('storeName tagline description logo banner address.city address.state createdAt')
      .lean();
    if (!vendor) return null;
    const [stats] = await Product.aggregate([
      { $match: { vendor: vendor._id, ...LISTED } },
      {
        $group: {
          _id: null,
          products: { $sum: 1 },
          sold: { $sum: '$sold' },
          reviews: { $sum: '$numReviews' },
          rating: { $avg: { $cond: [{ $gt: ['$numReviews', 0] }, '$rating', null] } },
          categories: { $addToSet: '$category' },
        },
      },
    ]);
    return { ...vendor, stats: { products: 0, sold: 0, reviews: 0, categories: [], ...stats, rating: round2(stats?.rating || 0) } };
  });
  if (!store) throw new ApiError(404, 'Store not found');
  res.json({ store });
}

/* -------------------------------------------------------------- reviews */

export const reviewSchema = z.object({
  rating: z.coerce.number().int().min(1, 'Pick a star rating').max(5),
  title: z.string().trim().max(100).optional().default(''),
  comment: z.string().trim().min(10, 'Tell others a little more (at least 10 characters)').max(2000),
});

async function hasDeliveredPurchase(userId, productId) {
  return Boolean(
    await Order.exists({
      customer: userId,
      'payment.status': 'paid',
      packages: { $elemMatch: { status: 'delivered', 'items.product': productId } },
    }),
  );
}

export async function getReviews(req, res) {
  const { productId } = req.params;
  if (!mongoose.isValidObjectId(productId)) throw new ApiError(400, 'Invalid product id');
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 6, maxLimit: 30 });
  const sorts = { recent: { createdAt: -1 }, top: { rating: -1, createdAt: -1 }, low: { rating: 1, createdAt: -1 } };
  const filter = { product: productId };
  if (req.query.rating) filter.rating = Number(req.query.rating);

  const [items, total, breakdown, mine, purchased] = await Promise.all([
    Review.find(filter).sort(sorts[req.query.sort] || sorts.recent).skip(skip).limit(limit).lean(),
    Review.countDocuments(filter),
    Review.aggregate([{ $match: { product: new mongoose.Types.ObjectId(productId) } }, { $group: { _id: '$rating', count: { $sum: 1 } } }]),
    req.user ? Review.find({ product: productId, user: req.user._id }).select('_id').lean() : [],
    req.user ? hasDeliveredPurchase(req.user._id, productId) : false,
  ]);

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  breakdown.forEach((b) => {
    distribution[b._id] = b.count;
  });
  res.json({ ...paginated(items, total, page, limit), distribution, myReviewIds: mine.map((r) => String(r._id)), hasPurchased: purchased });
}

async function recalcRating(productId) {
  const [stats] = await Review.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(String(productId)) } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  const product = await Product.findByIdAndUpdate(
    productId,
    { rating: round2(stats?.avg || 0), numReviews: stats?.count || 0 },
    { new: true },
  ).lean();
  await invalidateProducts([product]);
  indexProducts([productId]);
  await recalcVendorRating(product.vendor);
}

export const reviewUpdateSchema = reviewSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to update');

/** A customer may post several reviews on the same product (e.g. after each purchase). */
export async function createReview(req, res) {
  if (req.user.role !== 'customer') throw new ApiError(403, 'Only customer accounts can write reviews');
  const product = await Product.findById(req.params.productId).select('_id').lean();
  if (!product) throw new ApiError(404, 'Product not found');

  const verified = await hasDeliveredPurchase(req.user._id, product._id);
  const review = await Review.create({ ...req.body, product: product._id, user: req.user._id, name: req.user.name, verified });
  await recalcRating(product._id);
  res.status(201).json({ review });
}

/** Loads a review of this product; only its author (or an admin, when allowed) may act on it. */
async function authoredReview(req, { allowAdmin = false } = {}) {
  const { productId, reviewId } = req.params;
  if (!mongoose.isValidObjectId(reviewId)) throw new ApiError(400, 'Invalid review id');
  const review = await Review.findOne({ _id: reviewId, product: productId });
  if (!review) throw new ApiError(404, 'Review not found');
  const isAuthor = String(review.user) === String(req.user._id);
  if (!isAuthor && !(allowAdmin && req.user.role === 'admin')) throw new ApiError(403, 'You can only change your own reviews');
  return review;
}

export async function updateReview(req, res) {
  const review = await authoredReview(req);
  Object.assign(review, req.body);
  await review.save();
  await recalcRating(review.product);
  res.json({ review });
}

export async function deleteReview(req, res) {
  const review = await authoredReview(req, { allowAdmin: true });
  await review.deleteOne();
  await recalcRating(review.product);
  res.json({ message: 'Review deleted' });
}

/* -------------------------------------------------------------- coupons */

/** Active coupons a shopper can use: platform-wide ones plus those of the given stores (?vendors=id1,id2). */
export async function publicCoupons(req, res) {
  const vendorIds = String(req.query.vendors || '')
    .split(',')
    .filter((id) => mongoose.isValidObjectId(id));
  const coupons = await Coupon.find({
    isActive: true,
    // Private coupons are left out of the list but still redeem when typed in at checkout.
    isPublic: { $ne: false },
    vendor: { $in: [null, ...vendorIds] },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  })
    .select('code description type value minOrder maxDiscount vendor expiresAt usageLimit usedCount')
    .populate('vendor', 'storeName')
    .sort({ minOrder: 1 })
    .limit(12)
    .lean();
  res.json({
    coupons: coupons
      .filter((c) => !c.usageLimit || c.usedCount < c.usageLimit)
      .map(({ usageLimit: _limit, usedCount: _used, ...c }) => c),
  });
}

/* -------------------------------------------------------------- uploads */

const UPLOAD_FOLDERS = ['products', 'stores', 'avatars'];

export async function uploadImages(req, res) {
  if (!req.files?.length) throw new ApiError(400, 'Choose at least one image to upload');
  const { folder } = req.query;
  if (!UPLOAD_FOLDERS.includes(folder)) throw new ApiError(400, `folder must be one of: ${UPLOAD_FOLDERS.join(', ')}`);
  // Store logos/banners are uploaded during onboarding, before a customer's role becomes "vendor".
  if (folder === 'products' && !['vendor', 'admin'].includes(req.user.role)) {
    throw new ApiError(403, 'Only sellers can upload product images');
  }
  const files = await Promise.all(req.files.map((file) => uploadFile(file, folder)));
  res.status(201).json({ files });
}
