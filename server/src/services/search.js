import mongoose from 'mongoose';
import { Client } from '@elastic/elasticsearch';
import { env } from '../config/env.js';
import { isListed, LISTED, Product } from '../models/Product.js';
import { Category } from '../models/Category.js';
import { logger } from '../utils/logger.js';
import { escapeRegex } from '../utils/http.js';

const INDEX = env.elastic.index;

let es = null;
let engine = 'mongodb';

const MAPPINGS = {
  properties: {
    title: { type: 'text', analyzer: 'english', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
    titleSuggest: { type: 'search_as_you_type' },
    description: { type: 'text', analyzer: 'english' },
    brand: { type: 'keyword', fields: { text: { type: 'text' } } },
    category: { type: 'keyword' },
    categoryName: { type: 'text' },
    tags: { type: 'text', fields: { keyword: { type: 'keyword' } } },
    vendorId: { type: 'keyword' },
    storeName: { type: 'text', fields: { keyword: { type: 'keyword' } } },
    storeSlug: { type: 'keyword' },
    price: { type: 'float' },
    mrp: { type: 'float' },
    discount: { type: 'integer' },
    rating: { type: 'float' },
    numRatings: { type: 'integer' },
    sold: { type: 'integer' },
    stock: { type: 'integer' },
    thumbnail: { type: 'keyword', index: false },
    isActive: { type: 'boolean' },
    createdAt: { type: 'date' },
  },
};

export const SORTS = ['relevance', 'popular', 'price_asc', 'price_desc', 'rating', 'newest', 'discount'];

export const searchEngine = () => engine;

export async function initSearch() {
  if (!env.elastic.node) {
    logger.warn('Elasticsearch: ELASTICSEARCH_NODE not set -> product search runs on MongoDB');
    return engine;
  }
  const { apiKey, username, password } = env.elastic;
  const client = new Client({
    node: env.elastic.node,
    auth: apiKey ? { apiKey } : username ? { username, password } : undefined,
    requestTimeout: 10000,
    maxRetries: 2,
  });
  try {
    await client.info();
    if (!(await client.indices.exists({ index: INDEX }))) {
      await client.indices.create({ index: INDEX, mappings: MAPPINGS });
      logger.info(`Elasticsearch: created index "${INDEX}"`);
    }
    es = client;
    engine = 'elasticsearch';
    logger.ok(`Elasticsearch connected -> ${env.elastic.node} (index "${INDEX}")`);
  } catch (err) {
    logger.warn(`Elasticsearch unavailable (${err.message}) -> product search runs on MongoDB`);
  }
  return engine;
}

/* ------------------------------------------------------------------ indexing */

let categoryCache = { at: 0, map: new Map() };
/** Call after a category is created, renamed or deleted. */
export const resetCategoryNames = () => {
  categoryCache.at = 0;
};
async function categoryNames() {
  if (Date.now() - categoryCache.at > 5 * 60 * 1000) {
    const cats = await Category.find().select('name').lean();
    categoryCache = { at: Date.now(), map: new Map(cats.map((c) => [String(c._id), c.name])) };
  }
  return categoryCache.map;
}

const toDoc = (p, names) => ({
  title: p.title,
  titleSuggest: p.title,
  description: (p.description || '').slice(0, 2000),
  brand: p.brand,
  category: String(p.category),
  categoryName: names.get(String(p.category)) || '',
  tags: p.tags || [],
  vendorId: String(p.vendor?._id || p.vendor),
  storeName: p.vendor?.storeName || '',
  price: p.price,
  mrp: p.mrp || p.price,
  discount: p.mrp > p.price ? Math.round(((p.mrp - p.price) / p.mrp) * 100) : 0,
  rating: p.rating || 0,
  numRatings: p.numRatings || 0,
  sold: p.sold || 0,
  stock: p.stock || 0,
  thumbnail: p.thumbnail || p.images?.[0]?.url || '',
  isActive: isListed(p) && (!p.vendor?.status || p.vendor.status === 'approved'),
  createdAt: p.createdAt,
});

const loadProducts = (filter) => Product.find(filter).populate('vendor', 'storeName status').lean();

/** Re-indexes the given products. Safe to call fire-and-forget; errors are logged, never thrown. */
export async function indexProducts(ids) {
  if (!es) return;
  const list = [ids].flat().filter(Boolean);
  if (!list.length) return;
  try {
    const [products, names] = await Promise.all([loadProducts({ _id: { $in: list } }), categoryNames()]);
    const found = new Set(products.map((p) => String(p._id)));
    const operations = products.flatMap((p) => [{ index: { _index: INDEX, _id: String(p._id) } }, toDoc(p, names)]);
    // Products that no longer exist in Mongo are removed from the index.
    list.filter((id) => !found.has(String(id))).forEach((id) => operations.push({ delete: { _index: INDEX, _id: String(id) } }));
    if (operations.length) await es.bulk({ operations, refresh: 'wait_for' });
  } catch (err) {
    logger.warn(`Elasticsearch indexing failed: ${err.message}`);
  }
}

export async function removeFromIndex(id) {
  if (!es) return;
  try {
    await es.delete({ index: INDEX, id: String(id), refresh: 'wait_for' });
  } catch (err) {
    if (err.meta?.statusCode !== 404) logger.warn(`Elasticsearch delete failed: ${err.message}`);
  }
}

/** Drops and rebuilds the index from MongoDB. Returns the number of indexed documents. */
export async function reindexAll() {
  if (!es) return 0;
  categoryCache.at = 0;
  if (await es.indices.exists({ index: INDEX })) await es.indices.delete({ index: INDEX });
  await es.indices.create({ index: INDEX, mappings: MAPPINGS });
  const names = await categoryNames();
  const products = await loadProducts({});
  for (let i = 0; i < products.length; i += 500) {
    const batch = products.slice(i, i + 500);
    const res = await es.bulk({
      operations: batch.flatMap((p) => [{ index: { _index: INDEX, _id: String(p._id) } }, toDoc(p, names)]),
    });
    if (res.errors) logger.warn('Elasticsearch bulk indexing reported item errors');
  }
  await es.indices.refresh({ index: INDEX });
  logger.ok(`Elasticsearch: indexed ${products.length} products`);
  return products.length;
}

/** Rebuilds the index when it is out of step with MongoDB (e.g. first boot, or after seeding). */
export async function syncIndexIfNeeded() {
  if (!es) return;
  try {
    const [{ count }, total] = await Promise.all([es.count({ index: INDEX }), Product.countDocuments()]);
    if (count !== total) {
      logger.info(`Elasticsearch has ${count} docs, MongoDB has ${total} products -> reindexing`);
      await reindexAll();
    }
  } catch (err) {
    logger.warn(`Elasticsearch sync check failed: ${err.message}`);
  }
}

export async function indexStats() {
  if (!es) return null;
  try {
    const { count } = await es.count({ index: INDEX });
    return { index: INDEX, documents: count };
  } catch {
    return { index: INDEX, documents: null };
  }
}

/* ------------------------------------------------------------------ querying */

function normalize(raw = {}) {
  const num = (v) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));
  const brands = []
    .concat(raw.brand || [])
    .flatMap((b) => String(b).split(','))
    .map((b) => b.trim())
    .filter(Boolean);
  return {
    q: String(raw.q || '').trim().slice(0, 100),
    category: mongoose.isValidObjectId(raw.category) ? String(raw.category) : '',
    brands,
    minPrice: num(raw.minPrice),
    maxPrice: num(raw.maxPrice),
    rating: num(raw.rating),
    inStock: ['1', 'true'].includes(String(raw.inStock)),
    vendor: mongoose.isValidObjectId(raw.vendor) ? String(raw.vendor) : '',
    sort: SORTS.includes(raw.sort) ? raw.sort : 'relevance',
    page: Math.max(1, parseInt(raw.page, 10) || 1),
    limit: Math.min(48, Math.max(1, parseInt(raw.limit, 10) || 24)),
  };
}

async function esSearch(p) {
  const filter = [{ term: { isActive: true } }];
  if (p.minPrice !== undefined || p.maxPrice !== undefined) {
    filter.push({ range: { price: { gte: p.minPrice, lte: p.maxPrice } } });
  }
  if (p.rating) filter.push({ range: { rating: { gte: p.rating } } });
  if (p.inStock) filter.push({ range: { stock: { gt: 0 } } });
  if (p.vendor) filter.push({ term: { vendorId: p.vendor } });

  const query = { bool: { filter } };
  if (p.q) {
    query.bool.must = [
      {
        multi_match: {
          query: p.q,
          fields: ['title^4', 'brand.text^3', 'categoryName^2', 'tags^2', 'storeName', 'description'],
          fuzziness: 'AUTO',
          prefix_length: 1,
        },
      },
    ];
    query.bool.should = [{ match_phrase_prefix: { title: { query: p.q, boost: 6 } } }];
  }

  // Category/brand go in post_filter so each facet still shows its other options (multi-select friendly).
  const categoryFilter = p.category ? { term: { category: p.category } } : null;
  const brandFilter = p.brands.length ? { terms: { brand: p.brands } } : null;
  const postFilters = [categoryFilter, brandFilter].filter(Boolean);

  const sortMap = {
    relevance: p.q ? ['_score', { sold: 'desc' }] : [{ sold: 'desc' }],
    popular: [{ sold: 'desc' }],
    price_asc: [{ price: 'asc' }],
    price_desc: [{ price: 'desc' }],
    rating: [{ rating: 'desc' }, { numRatings: 'desc' }],
    newest: [{ createdAt: 'desc' }],
    discount: [{ discount: 'desc' }],
  };

  const res = await es.search({
    index: INDEX,
    from: (p.page - 1) * p.limit,
    size: p.limit,
    track_total_hits: true,
    query,
    post_filter: postFilters.length ? { bool: { filter: postFilters } } : undefined,
    sort: sortMap[p.sort],
    _source: { excludes: ['description', 'titleSuggest'] },
    aggs: {
      categories: {
        filter: brandFilter || { match_all: {} },
        aggs: { values: { terms: { field: 'category', size: 60 } } },
      },
      brands: {
        filter: categoryFilter || { match_all: {} },
        aggs: { values: { terms: { field: 'brand', size: 60 } } },
      },
      price: { stats: { field: 'price' } },
    },
  });

  const total = typeof res.hits.total === 'number' ? res.hits.total : res.hits.total.value;
  const bucket = (agg) => agg.values.buckets.map((b) => ({ key: b.key, count: b.doc_count }));
  return {
    items: res.hits.hits.map((hit) => ({ _id: hit._id, ...hit._source })),
    total,
    facets: {
      categories: bucket(res.aggregations.categories),
      brands: bucket(res.aggregations.brands),
      price: { min: res.aggregations.price.min ?? 0, max: res.aggregations.price.max ?? 0 },
    },
  };
}

async function mongoSearch(p) {
  const base = { ...LISTED };
  if (p.q) {
    const words = p.q.split(/\s+/).filter(Boolean).slice(0, 6);
    const names = await categoryNames();
    base.$and = words.map((word) => {
      const rx = new RegExp(escapeRegex(word), 'i');
      // Words match category names ("laptop" finds the Laptops category), never ids.
      const categoryIds = [...names].filter(([, name]) => rx.test(name)).map(([id]) => new mongoose.Types.ObjectId(id));
      return { $or: [{ title: rx }, { brand: rx }, { category: { $in: categoryIds } }, { tags: rx }, { description: rx }] };
    });
  }
  if (p.minPrice !== undefined || p.maxPrice !== undefined) {
    base.price = {};
    if (p.minPrice !== undefined) base.price.$gte = p.minPrice;
    if (p.maxPrice !== undefined) base.price.$lte = p.maxPrice;
  }
  if (p.rating) base.rating = { $gte: p.rating };
  if (p.inStock) base.stock = { $gt: 0 };
  if (p.vendor) base.vendor = new mongoose.Types.ObjectId(p.vendor);

  const categoryFilter = p.category ? { category: new mongoose.Types.ObjectId(p.category) } : {};
  const brandFilter = p.brands.length ? { brand: { $in: p.brands } } : {};
  const sortMap = {
    relevance: { sold: -1 },
    popular: { sold: -1 },
    price_asc: { price: 1 },
    price_desc: { price: -1 },
    rating: { rating: -1, numRatings: -1 },
    newest: { createdAt: -1 },
    discount: { discount: -1 },
  };

  const [result] = await Product.aggregate([
    { $match: base },
    { $lookup: { from: 'vendors', localField: 'vendor', foreignField: '_id', as: 'v', pipeline: [{ $project: { storeName: 1, status: 1 } }] } },
    { $set: { v: { $first: '$v' } } },
    { $match: { 'v.status': 'approved' } },
    {
      $facet: {
        items: [
          { $match: { ...categoryFilter, ...brandFilter } },
          { $set: { discount: { $cond: [{ $gt: ['$mrp', '$price'] }, { $round: [{ $multiply: [{ $divide: [{ $subtract: ['$mrp', '$price'] }, '$mrp'] }, 100] }, 0] }, 0] } } },
          { $sort: { ...sortMap[p.sort], _id: 1 } },
          { $skip: (p.page - 1) * p.limit },
          { $limit: p.limit },
          {
            $project: {
              title: 1, brand: 1, category: 1, price: 1, mrp: 1, discount: 1, rating: 1, numRatings: 1,
              sold: 1, stock: 1, thumbnail: 1, createdAt: 1, vendorId: '$v._id', storeName: '$v.storeName',
            },
          },
        ],
        total: [{ $match: { ...categoryFilter, ...brandFilter } }, { $count: 'n' }],
        categories: [{ $match: brandFilter }, { $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        brands: [{ $match: categoryFilter }, { $group: { _id: '$brand', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 60 }],
        price: [{ $group: { _id: null, min: { $min: '$price' }, max: { $max: '$price' } } }],
      },
    },
  ]);

  return {
    items: result.items,
    total: result.total[0]?.n || 0,
    facets: {
      categories: result.categories.map((c) => ({ key: String(c._id), count: c.count })),
      brands: result.brands.map((b) => ({ key: b._id, count: b.count })),
      price: { min: result.price[0]?.min ?? 0, max: result.price[0]?.max ?? 0 },
    },
  };
}

export async function searchProducts(rawParams) {
  const params = normalize(rawParams);
  let result = null;
  let usedEngine = 'mongodb';
  if (es) {
    try {
      result = await esSearch(params);
      usedEngine = 'elasticsearch';
    } catch (err) {
      logger.warn(`Elasticsearch query failed (${err.message}) -> MongoDB fallback`);
    }
  }
  if (!result) result = await mongoSearch(params);
  return {
    ...result,
    page: params.page,
    limit: params.limit,
    pages: Math.max(1, Math.ceil(result.total / params.limit)),
    engine: usedEngine,
  };
}

/** Typeahead suggestions for the search bar. */
export async function suggest(rawQuery) {
  const q = String(rawQuery || '').trim().slice(0, 60);
  if (q.length < 2) return { products: [], categories: [] };

  const categoriesPromise = Category.find({ isActive: true, name: new RegExp(escapeRegex(q), 'i') })
    .select('name image')
    .limit(3)
    .lean();

  let products = null;
  if (es) {
    try {
      const res = await es.search({
        index: INDEX,
        size: 6,
        query: {
          bool: {
            filter: [{ term: { isActive: true } }],
            must: [
              {
                multi_match: {
                  query: q,
                  type: 'bool_prefix',
                  fields: ['titleSuggest', 'titleSuggest._2gram', 'titleSuggest._3gram'],
                },
              },
            ],
          },
        },
        _source: ['title', 'thumbnail', 'price', 'category', 'brand'],
      });
      products = res.hits.hits.map((h) => ({ _id: h._id, ...h._source }));
    } catch (err) {
      logger.warn(`Elasticsearch suggest failed (${err.message}) -> MongoDB fallback`);
    }
  }
  if (!products) {
    products = await Product.find({ ...LISTED, title: new RegExp(`(^|\\s)${escapeRegex(q)}`, 'i') })
      .sort({ sold: -1 })
      .limit(6)
      .select('title thumbnail price category brand')
      .lean();
  }
  return { products, categories: await categoriesPromise };
}
