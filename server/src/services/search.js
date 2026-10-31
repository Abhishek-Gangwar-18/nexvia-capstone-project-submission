import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Client } from '@elastic/elasticsearch';
import { env } from '../config/env.js';
import { isListed, LISTED, Product } from '../models/Product.js';
import { Category } from '../models/Category.js';
import { withLock } from './locks.js';
import { logger } from '../utils/logger.js';
import { escapeRegex } from '../utils/http.js';

/** Searches and writes go through this alias. It points at one built index, e.g. vendora-products-v2-1761830000000. */
export const ALIAS = env.elastic.index;
/** Bump when SETTINGS or MAPPINGS change: the next start builds a new index and switches the alias to it. */
export const INDEX_VERSION = 4;
const PROBE_MS = 15 * 1000;

let es = null;
let available = false;
let probe = null;
let recovering = false;

/**
 * Search-time synonyms (shoppers type either word). Rules pass through the same lowercase and stemming
 * filters as the text, so plurals match too ("mobiles" finds smartphones).
 */
const SYNONYMS = [
  'phone, mobile, smartphone, cellphone',
  'laptop, notebook',
  'tablet, tab',
  'tv, television',
  'earphones, earbuds, earpods',
  'headphones, headset',
  'tshirt, t shirt, tee',
  'trousers, pants',
  'jeans, denim',
  'sneakers, trainers',
  'perfume, fragrance, cologne',
  'skincare, skin care',
  'makeup, make up, cosmetics',
  'sunglasses, shades, goggles',
  'spectacles, eyeglasses, specs',
  'sofa, couch',
  'fridge, refrigerator',
  'ac, air conditioner',
  'powerbank, power bank',
  'charger, adapter',
  'decor, decoration',
  'jewellery, jewelry',
  'colour, color',
  'grey, gray',
  'gym, fitness, workout',
];

export const SETTINGS = {
  number_of_shards: 1,
  // 0 replicas on a single node (green instead of yellow), 1 as soon as a second node joins.
  auto_expand_replicas: '0-1',
  analysis: {
    filter: {
      english_possessive: { type: 'stemmer', language: 'possessive_english' },
      english_light: { type: 'stemmer', language: 'light_english' },
      product_synonyms: { type: 'synonym_graph', synonyms: SYNONYMS },
      spell_shingle: { type: 'shingle', min_shingle_size: 2, max_shingle_size: 3 },
    },
    analyzer: {
      product_text: { tokenizer: 'standard', filter: ['lowercase', 'asciifolding', 'english_possessive', 'english_light'] },
      product_search: { tokenizer: 'standard', filter: ['lowercase', 'asciifolding', 'english_possessive', 'english_light', 'product_synonyms'] },
      // Spelling correction works on whole, unstemmed words ("Did you mean: samsung galaxy?").
      spell_text: { tokenizer: 'standard', filter: ['lowercase', 'asciifolding'] },
      spell_shingle: { tokenizer: 'standard', filter: ['lowercase', 'asciifolding', 'spell_shingle'] },
    },
  },
};

const text = (extra = {}) => ({ type: 'text', analyzer: 'product_text', search_analyzer: 'product_search', ...extra });

export const MAPPINGS = {
  dynamic: 'strict',
  _meta: { version: INDEX_VERSION },
  properties: {
    // Title, brand, category, tags, specs and store in one field, so every typed word can match a different one.
    searchText: text(),
    title: text({ copy_to: 'searchText', fields: { keyword: { type: 'keyword', ignore_above: 256 } } }),
    titleSuggest: { type: 'search_as_you_type' },
    // Words and 2-3 word phrases of title, brand, category and tags: the vocabulary "Did you mean" corrects towards.
    spell: { type: 'text', analyzer: 'spell_text', fields: { trigram: { type: 'text', analyzer: 'spell_shingle' } } },
    description: text(),
    brand: { type: 'keyword', copy_to: 'searchText', fields: { text: text() } },
    category: { type: 'keyword' },
    categoryName: text({ copy_to: 'searchText' }),
    tags: text({ copy_to: 'searchText' }),
    specs: text({ copy_to: 'searchText' }),
    vendorId: { type: 'keyword' },
    storeName: text({ copy_to: 'searchText', fields: { keyword: { type: 'keyword' } } }),
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

export const SORTS = ['popular', 'price_asc', 'price_desc', 'rating', 'newest', 'discount'];

/** The engine serving searches right now: MongoDB while Elasticsearch is not configured or unreachable. */
export const searchEngine = () => (available ? 'elasticsearch' : 'mongodb');
export const searchConfigured = () => Boolean(es);

/** Connection trouble (as opposed to a bad request): search moves to MongoDB until Elasticsearch answers again. */
const isOutage = (err) =>
  ['ConnectionError', 'TimeoutError', 'NoLivingConnectionsError'].includes(err?.name) || [502, 503, 504].includes(err?.meta?.statusCode);

function markDown(err) {
  if (!available) return;
  available = false;
  logger.warn(`Elasticsearch unreachable (${err.message}) -> search runs on MongoDB, reconnecting every ${PROBE_MS / 1000} s`);
  watchForRecovery();
}

function watchForRecovery() {
  if (probe) return;
  probe = setInterval(recoverSearch, PROBE_MS);
  probe.unref();
}

/**
 * Runs every 15 s while Elasticsearch is down. Writes are skipped during an outage, so once it answers the
 * index is rebuilt from MongoDB before search switches back. Returns whether Elasticsearch is in use.
 */
export async function recoverSearch() {
  if (!es || available || recovering) return available;
  recovering = true;
  try {
    await es.ping();
    try {
      await rebuildIndex();
    } catch (err) {
      // Another instance is rebuilding right now: its index is about to be live.
      if (err.status !== 409) throw err;
    }
    available = true;
    clearInterval(probe);
    probe = null;
    logger.ok('Elasticsearch is back -> index rebuilt from MongoDB, search runs on Elasticsearch again');
  } catch {
    // Still down (or the rebuild failed): try again on the next tick.
  } finally {
    recovering = false;
  }
  return available;
}

export async function initSearch() {
  if (!env.elastic.node) {
    logger.warn('Elasticsearch: ELASTICSEARCH_NODE not set -> product search runs on MongoDB');
    return searchEngine();
  }
  const { apiKey, username, password } = env.elastic;
  es = new Client({
    node: env.elastic.node,
    auth: apiKey ? { apiKey } : username ? { username, password } : undefined,
    // A search that can't be answered quickly falls back to MongoDB instead of holding the request.
    requestTimeout: 5000,
    maxRetries: 1,
  });
  try {
    await es.info();
    available = true;
    logger.ok(`Elasticsearch connected -> ${env.elastic.node} (alias "${ALIAS}")`);
  } catch (err) {
    available = false;
    logger.warn(`Elasticsearch unavailable (${err.message}) -> search runs on MongoDB, reconnecting every ${PROBE_MS / 1000} s`);
    watchForRecovery();
  }
  return searchEngine();
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

/** Search document for a product (vendor populated with storeName and status). */
export const toDoc = (p, names) => ({
  title: p.title,
  titleSuggest: p.title,
  spell: [p.title, p.brand, names.get(String(p.category)), ...(p.tags || [])].filter(Boolean),
  description: (p.description || '').slice(0, 2000),
  brand: p.brand || '',
  category: String(p.category),
  categoryName: names.get(String(p.category)) || '',
  tags: p.tags || [],
  specs: (p.specs || []).map((s) => `${s.label} ${s.value}`),
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
  // Same rule as the MongoDB search: listed, and its store exists and is approved.
  isActive: isListed(p) && p.vendor?.status === 'approved',
  createdAt: p.createdAt,
});

const loadProducts = (filter) => Product.find(filter).populate('vendor', 'storeName status').lean();

/** Writes documents (and deletes the ids given in `missing`); item-level failures are logged, not thrown. */
async function bulkIndex(index, products, names, missing = []) {
  const operations = products.flatMap((p) => [{ index: { _index: index, _id: String(p._id) } }, toDoc(p, names)]);
  missing.forEach((id) => operations.push({ delete: { _index: index, _id: String(id) } }));
  if (!operations.length) return;
  const res = await es.bulk({ operations }, { requestTimeout: 60 * 1000 });
  if (!res.errors) return;
  const failed = res.items.map((item) => Object.values(item)[0]).filter((item) => item.error);
  if (failed.length) logger.warn(`Elasticsearch: ${failed.length} of ${res.items.length} documents failed (${failed[0].error.reason})`);
}

async function writeProducts(index, ids) {
  const list = [...new Set([ids].flat().filter(Boolean).map(String))];
  if (!list.length) return;
  const [products, names] = await Promise.all([loadProducts({ _id: { $in: list } }), categoryNames()]);
  const found = new Set(products.map((p) => String(p._id)));
  // Ids that no longer exist in MongoDB are removed from the index.
  await bulkIndex(index, products, names, list.filter((id) => !found.has(id)));
}

/**
 * Re-indexes the given products (deleted and hidden ones stay in the index as inactive). Safe to call
 * fire-and-forget: errors are logged, never thrown. Skipped while Elasticsearch is down; recovery rebuilds.
 */
export async function indexProducts(ids) {
  if (!available) return;
  try {
    await writeProducts(ALIAS, ids);
  } catch (err) {
    if (isOutage(err)) markDown(err);
    else logger.warn(`Elasticsearch indexing failed: ${err.message}`);
  }
}

/** The built indices behind the alias (normally one) and their version; null when there is no index yet. */
async function currentIndex() {
  try {
    const res = await es.indices.getMapping({ index: ALIAS });
    const names = Object.keys(res);
    return { names, version: res[names[0]]?.mappings?._meta?.version ?? 0, plainIndex: names.includes(ALIAS) };
  } catch (err) {
    if (err.meta?.statusCode === 404) return null;
    throw err;
  }
}

/** Points the alias at `name` in one atomic step, then deletes the builds it replaced. */
async function switchAlias(name) {
  const current = await currentIndex();
  const actions = [];
  // An index created before aliases were used has the alias's own name: it is dropped in the same step.
  if (current?.plainIndex) actions.push({ remove_index: { index: ALIAS } });
  else current?.names.forEach((index) => actions.push({ remove: { index, alias: ALIAS } }));
  actions.push({ add: { index: name, alias: ALIAS } });
  await es.indices.updateAliases({ actions });
  const builds = Object.keys(await es.indices.get({ index: `${ALIAS}-v*` })).filter((index) => index !== name);
  if (builds.length) await es.indices.delete({ index: builds.join(',') });
}

/**
 * Builds a new index from MongoDB next to the live one and switches the alias when it is complete, so
 * search never sees an empty or half-built index. One rebuild at a time across all API instances.
 */
async function rebuildIndex() {
  return withLock('search:reindex', 10 * 60, 'A search reindex is already running', async () => {
    const startedAt = new Date();
    // The random part keeps two rebuilds started in the same millisecond from colliding.
    const name = `${ALIAS}-v${INDEX_VERSION}-${startedAt.getTime()}-${crypto.randomBytes(3).toString('hex')}`;
    await es.indices.create({ index: name, settings: SETTINGS, mappings: MAPPINGS });
    let count;
    try {
      categoryCache.at = 0;
      const [names, products] = await Promise.all([categoryNames(), loadProducts({})]);
      for (let i = 0; i < products.length; i += 500) await bulkIndex(name, products.slice(i, i + 500), names);
      await es.indices.refresh({ index: name });
      await switchAlias(name);
      count = products.length;
    } catch (err) {
      await es.indices.delete({ index: name }).catch(() => {});
      throw err;
    }
    // Product writes made while the new index was filling went to the old one: write them again.
    const changed = await Product.find({ updatedAt: { $gte: startedAt } }).distinct('_id');
    await writeProducts(ALIAS, changed);
    logger.ok(`Elasticsearch: indexed ${count} products into "${name}" (alias "${ALIAS}")`);
    return count;
  });
}

/** Admin "Reindex" and the seed script: rebuilds the index from MongoDB. Returns the number of products. */
export async function reindexAll() {
  if (!available) return 0;
  return rebuildIndex();
}

/** Rebuilds the index on startup when it is missing, built with older settings, or out of step with MongoDB. */
export async function syncIndexIfNeeded() {
  if (!available) return;
  try {
    const current = await currentIndex();
    let reason = null;
    if (!current) reason = 'no index yet';
    else if (current.version !== INDEX_VERSION) reason = `index version ${current.version} -> ${INDEX_VERSION}`;
    else {
      const [{ count }, total] = await Promise.all([es.count({ index: ALIAS }), Product.countDocuments()]);
      if (count !== total) reason = `${count} documents for ${total} products`;
    }
    if (!reason) return;
    logger.info(`Elasticsearch: building the index (${reason})`);
    await rebuildIndex();
  } catch (err) {
    if (isOutage(err)) markDown(err);
    else logger.warn(`Elasticsearch sync check failed: ${err.message}`);
  }
}

export async function indexStats() {
  if (!es) return null;
  if (!available) return { index: ALIAS, documents: null, reachable: false };
  try {
    const [current, { count }] = await Promise.all([currentIndex(), es.count({ index: ALIAS })]);
    return { index: ALIAS, build: current?.names[0] ?? null, version: current?.version ?? null, documents: count, reachable: true };
  } catch {
    return { index: ALIAS, documents: null, reachable: true };
  }
}

/* ------------------------------------------------------------------ querying */

export function normalizeSearchParams(raw = {}) {
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
    sort: SORTS.includes(raw.sort) ? raw.sort : 'popular',
    page: Math.max(1, parseInt(raw.page, 10) || 1),
    limit: Math.min(48, Math.max(1, parseInt(raw.limit, 10) || 24)),
  };
}

/** Same fields as the MongoDB search returns, so product cards look identical on either engine. */
const RESULT_FIELDS = ['title', 'brand', 'category', 'price', 'mrp', 'discount', 'rating', 'numRatings', 'sold', 'stock', 'thumbnail', 'createdAt', 'vendorId', 'storeName'];

/**
 * The search request for normalized params. Strict: every typed word must match (typos allowed, in any of
 * title, brand, category, tags, specs or store). Relaxed (used only when strict finds nothing): any word,
 * description included.
 */
export function buildSearchRequest(p, { relaxed = false, index = ALIAS } = {}) {
  const filter = [{ term: { isActive: true } }];
  if (p.minPrice !== undefined || p.maxPrice !== undefined) {
    filter.push({ range: { price: { gte: p.minPrice, lte: p.maxPrice } } });
  }
  if (p.rating) filter.push({ range: { rating: { gte: p.rating } } });
  if (p.inStock) filter.push({ range: { stock: { gt: 0 } } });
  if (p.vendor) filter.push({ term: { vendorId: p.vendor } });

  const query = { bool: { filter } };
  if (p.q) {
    const typo = { fuzziness: 'AUTO', prefix_length: 1 };
    query.bool.must = [
      relaxed
        ? { multi_match: { query: p.q, fields: ['searchText', 'description^0.5'], ...typo } }
        : { match: { searchText: { query: p.q, operator: 'and', ...typo } } },
    ];
    // Ranking: the words as a phrase in the title first, then all of them in the title, then brand and category.
    query.bool.should = [
      { match_phrase: { title: { query: p.q, slop: 2, boost: 5 } } },
      { match: { title: { query: p.q, operator: 'and', boost: 3 } } },
      { match: { 'brand.text': { query: p.q, boost: 2 } } },
      { match: { categoryName: { query: p.q, boost: 2 } } },
      { match: { tags: { query: p.q, boost: 1 } } },
    ];
  }

  // Category/brand go in post_filter so each facet still shows its other options (multi-select friendly).
  const categoryFilter = p.category ? { term: { category: p.category } } : null;
  const brandFilter = p.brands.length ? { terms: { brand: p.brands } } : null;
  const postFilters = [categoryFilter, brandFilter].filter(Boolean);

  const sortMap = {
    // The default sort. With search text the best matches still come first (then sales); without it,
    // best-sellers first. Unknown sorts (e.g. an old ?sort=relevance link) fall back to this.
    popular: p.q ? ['_score', { sold: 'desc' }] : [{ sold: 'desc' }],
    price_asc: [{ price: 'asc' }],
    price_desc: [{ price: 'desc' }],
    rating: [{ rating: 'desc' }, { numRatings: 'desc' }],
    newest: [{ createdAt: 'desc' }],
    discount: [{ discount: 'desc' }],
  };

  return {
    index,
    from: (p.page - 1) * p.limit,
    size: p.limit,
    track_total_hits: true,
    query,
    post_filter: postFilters.length ? { bool: { filter: postFilters } } : undefined,
    // createdAt breaks ties, so equal values never swap places between pages.
    sort: [...sortMap[p.sort], { createdAt: 'desc' }],
    _source: RESULT_FIELDS,
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
  };
}

export function readSearchResponse(res) {
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

/** Strict query first; when nothing has every word, products matching some of them (flagged `relaxed`). */
export async function runSearch(client, p, index = ALIAS) {
  const result = readSearchResponse(await client.search(buildSearchRequest(p, { index })));
  if (result.total || !p.q.includes(' ')) return result;
  const loose = readSearchResponse(await client.search(buildSearchRequest(p, { index, relaxed: true })));
  return loose.total ? { ...loose, relaxed: true } : result;
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
  const params = normalizeSearchParams(rawParams);
  let result = null;
  let usedEngine = 'mongodb';
  if (available) {
    try {
      result = await runSearch(es, params);
      usedEngine = 'elasticsearch';
    } catch (err) {
      if (isOutage(err)) markDown(err);
      else logger.warn(`Elasticsearch query failed (${err.message}) -> MongoDB fallback`);
    }
  }
  if (!result) result = await mongoSearch(params);
  return {
    relaxed: false,
    ...result,
    page: params.page,
    limit: params.limit,
    pages: Math.max(1, Math.ceil(result.total / params.limit)),
    engine: usedEngine,
  };
}

/**
 * Typeahead: the last word is a prefix ("gala" -> Galaxy), earlier words may have a typo. The same request
 * asks for a spelling correction, kept only when it finds at least one product shoppers can see.
 */
export const buildSuggestRequest = (q, { index = ALIAS } = {}) => ({
  index,
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
            fuzziness: 'AUTO',
            prefix_length: 1,
          },
        },
      ],
    },
  },
  sort: ['_score', { sold: 'desc' }],
  _source: ['title', 'thumbnail', 'price', 'category', 'brand'],
  suggest: {
    text: q,
    correction: {
      phrase: {
        field: 'spell.trigram',
        size: 1,
        max_errors: 2,
        direct_generator: [{ field: 'spell.trigram' }],
        collate: {
          query: { source: { bool: { filter: [{ term: { isActive: true } }, { match: { spell: { query: '{{suggestion}}', operator: 'and' } } }] } } },
        },
      },
    },
  },
});

/**
 * The "Did you mean" text, or null. A completion of what is being typed ("gala" -> "galaxy") is not a
 * correction: the product suggestions already cover it.
 */
export function readCorrection(q, res) {
  const text = res.suggest?.correction?.[0]?.options?.[0]?.text;
  if (!text) return null;
  const typed = q.toLowerCase().split(/\s+/).filter(Boolean);
  const words = text.split(/\s+/);
  const changed = words.length !== typed.length || words.some((word, i) => !word.startsWith(typed[i]));
  return changed ? text : null;
}

/** Typeahead suggestions for the search bar. */
export async function suggest(rawQuery) {
  const q = String(rawQuery || '').trim().slice(0, 60);
  if (q.length < 2) return { products: [], categories: [], didYouMean: null };

  const categoriesPromise = Category.find({ isActive: true, name: new RegExp(escapeRegex(q), 'i') })
    .select('name image')
    .limit(3)
    .lean();

  let products = null;
  let didYouMean = null;
  if (available) {
    try {
      const res = await es.search(buildSuggestRequest(q));
      products = res.hits.hits.map((h) => ({ _id: h._id, ...h._source }));
      didYouMean = readCorrection(q, res);
    } catch (err) {
      if (isOutage(err)) markDown(err);
      else logger.warn(`Elasticsearch suggest failed (${err.message}) -> MongoDB fallback`);
    }
  }
  if (!products) {
    products = await Product.find({ ...LISTED, title: new RegExp(`(^|\\s)${escapeRegex(q)}`, 'i') })
      .sort({ sold: -1 })
      .limit(6)
      .select('title thumbnail price category brand')
      .lean();
  }
  return { products, categories: await categoriesPromise, didYouMean };
}
