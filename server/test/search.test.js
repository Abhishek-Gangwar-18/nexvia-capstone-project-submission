/**
 * Elasticsearch sync and failover: versioned index behind an alias, one rebuild at a time, any-word fallback,
 * and an outage moving search to MongoDB until recovery has rebuilt the index.
 * No Elasticsearch, database or Redis is touched: the client is faked and the models are stubbed.
 * Run: pnpm test
 */
import { beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ELASTICSEARCH_NODE = 'http://es.test:9200'; // dotenv never overrides a variable that is already set
process.env.ELASTICSEARCH_INDEX = 'vendora-test';
const ALIAS = 'vendora-test';

/* ------------------------------------------------------- fake Elasticsearch */

const es = { down: false, indices: new Map(), aliases: new Map(), actions: [], calls: 0, bulkGate: null, onSearch: null };
const outage = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9200'), { name: 'ConnectionError' });
const notFound = () => Object.assign(new Error('index_not_found_exception'), { name: 'ResponseError', meta: { statusCode: 404 } });
const call = () => {
  es.calls += 1;
  if (es.down) throw outage();
};
const resolve = (name) => (es.aliases.get(name)?.size ? [...es.aliases.get(name)] : es.indices.has(name) ? [name] : []);
const hits = (n) => ({
  hits: { total: { value: n }, hits: Array.from({ length: n }, (_, i) => ({ _id: `p${i}`, _source: { title: `Product ${i}` } })) },
  aggregations: { categories: { values: { buckets: [] } }, brands: { values: { buckets: [] } }, price: { min: 1, max: 9 } },
});

class FakeClient {
  indices = {
    create: async ({ index, mappings }) => {
      call();
      es.indices.set(index, { version: mappings._meta.version, docs: new Map() });
    },
    delete: async ({ index }) => {
      call();
      index.split(',').forEach((name) => es.indices.delete(name));
    },
    refresh: async () => call(),
    getMapping: async ({ index }) => {
      call();
      const names = resolve(index);
      if (!names.length) throw notFound();
      return Object.fromEntries(names.map((name) => [name, { mappings: { _meta: { version: es.indices.get(name).version } } }]));
    },
    get: async ({ index }) => {
      call();
      const prefix = index.replace('*', '');
      return Object.fromEntries([...es.indices.keys()].filter((name) => name.startsWith(prefix)).map((name) => [name, {}]));
    },
    updateAliases: async ({ actions }) => {
      call();
      es.actions.push(actions);
      for (const action of actions) {
        if (action.remove_index) es.indices.delete(action.remove_index.index);
        if (action.remove) es.aliases.get(action.remove.alias)?.delete(action.remove.index);
        if (action.add) es.aliases.set(action.add.alias, new Set([...(es.aliases.get(action.add.alias) || []), action.add.index]));
      }
    },
  };

  async info() {
    call();
    return { version: { number: '8.19.2' } };
  }

  async ping() {
    call();
    return true;
  }

  async bulk({ operations }) {
    call();
    if (es.bulkGate) await es.bulkGate;
    for (let i = 0; i < operations.length; i += 1) {
      const op = operations[i];
      const target = (meta) => es.indices.get(resolve(meta._index)[0]).docs;
      if (op.index) target(op.index).set(op.index._id, operations[++i]);
      else if (op.delete) target(op.delete).delete(op.delete._id);
    }
    return { errors: false, items: [] };
  }

  async count({ index }) {
    call();
    const [name] = resolve(index);
    if (!name) throw notFound();
    return { count: es.indices.get(name).docs.size };
  }

  async search(request) {
    call();
    return es.onSearch(request);
  }
}
mock.module('@elastic/elasticsearch', { exports: { Client: FakeClient } });

/* ------------------------------------------------------------ stubbed models */

const { Product } = await import('../src/models/Product.js');
const { Category } = await import('../src/models/Category.js');
const search = await import('../src/services/search.js');

const id = (n) => n.toString(16).padStart(24, '0');
const CATEGORY = id(50);
const store = { _id: id(60), storeName: 'TechNova', status: 'approved' };
const product = (n, extra = {}) => ({ _id: id(n), title: `Phone ${n}`, brand: 'Samsung', category: CATEGORY, price: 100, isActive: true, vendor: store, createdAt: new Date(), ...extra });
const db = { products: [], changed: [] };

Product.find = (filter = {}) => {
  const ids = filter._id?.$in?.map(String);
  const rows = () => db.products.filter((p) => !ids || ids.includes(String(p._id))).map((p) => structuredClone(p));
  return { populate: () => ({ lean: async () => rows() }), distinct: async () => db.changed };
};
Product.countDocuments = async () => db.products.length;
Product.aggregate = async () => [{ items: [{ title: 'From MongoDB' }], total: [{ n: 1 }], categories: [], brands: [], price: [] }];
Category.find = () => ({ select: () => ({ lean: async () => [{ _id: CATEGORY, name: 'Smartphones' }] }) });

const liveBuild = () => [...(es.aliases.get(ALIAS) || [])][0];
const docsOf = (build) => es.indices.get(build).docs;

beforeEach(async () => {
  Object.assign(es, { down: false, indices: new Map(), aliases: new Map(), actions: [], calls: 0, bulkGate: null, onSearch: () => hits(1) });
  db.products = [product(1), product(2, { vendor: { ...store, status: 'suspended' } }), product(3, { vendor: null }), product(4, { deletedAt: new Date() })];
  db.changed = [];
  await search.initSearch();
});

/* --------------------------------------------------------------------- tests */

describe('index build', () => {
  test('startup builds a versioned index behind the alias; only sellable products are searchable', async () => {
    await search.syncIndexIfNeeded();
    const build = liveBuild();
    assert.match(build, new RegExp(`^${ALIAS}-v${search.INDEX_VERSION}-\\d+-[a-f\\d]{6}$`));
    const docs = docsOf(build);
    assert.equal(docs.size, 4, 'deleted and hidden products stay in the index, inactive');
    assert.deepEqual([...docs.values()].map((d) => d.isActive), [true, false, false, false]);

    await search.syncIndexIfNeeded();
    assert.equal(liveBuild(), build, 'an up-to-date index was rebuilt');
  });

  test('an index from older settings is replaced in one atomic alias switch', async () => {
    es.indices.set(ALIAS, { version: 1, docs: new Map() }); // plain index from before aliases
    await search.syncIndexIfNeeded();
    const [actions] = es.actions;
    assert.deepEqual(actions[0], { remove_index: { index: ALIAS } });
    assert.deepEqual(actions[1], { add: { index: liveBuild(), alias: ALIAS } });

    const first = liveBuild();
    await search.reindexAll();
    assert.notEqual(liveBuild(), first);
    assert.equal(es.indices.has(first), false, 'the replaced build was not deleted');
  });

  test('only one rebuild runs at a time; a second one gets 409', async () => {
    let open;
    es.bulkGate = new Promise((resolve) => (open = resolve));
    const first = search.reindexAll();
    await new Promise(setImmediate);
    await assert.rejects(search.reindexAll(), { status: 409 });
    open();
    assert.equal(await first, 4);
  });

  test('a product changed while the index was filling is written again after the switch', async () => {
    let open;
    es.bulkGate = new Promise((resolve) => (open = resolve));
    const rebuild = search.reindexAll();
    await new Promise(setImmediate);
    db.products[0].title = 'Renamed while indexing';
    db.changed = [id(1)];
    open();
    await rebuild;
    assert.equal(docsOf(liveBuild()).get(id(1)).title, 'Renamed while indexing');
  });
});

describe('searching', () => {
  test('when no product has every word, products matching some of them are shown and flagged', async () => {
    const requests = [];
    es.onSearch = (request) => {
      requests.push(request);
      return hits(request.query.bool.must[0].match ? 0 : 2);
    };
    const result = await search.searchProducts({ q: 'nike earbuds' });
    assert.equal(requests[0].query.bool.must[0].match.searchText.operator, 'and');
    assert.deepEqual([result.engine, result.relaxed, result.total], ['elasticsearch', true, 2]);

    requests.length = 0;
    const single = await search.searchProducts({ q: 'zzzz' });
    assert.deepEqual([requests.length, single.relaxed, single.total], [1, false, 0], 'a one-word miss is not relaxed');
  });

  test('an outage moves search to MongoDB at once; recovery rebuilds the index before switching back', async () => {
    await search.syncIndexIfNeeded();
    const before = liveBuild();

    es.down = true;
    const during = await search.searchProducts({ q: 'galaxy' });
    assert.deepEqual([during.engine, during.items[0].title], ['mongodb', 'From MongoDB']);
    assert.equal(search.searchEngine(), 'mongodb');

    const calls = es.calls;
    await search.searchProducts({ q: 'galaxy' });
    await search.indexProducts([id(1)]);
    assert.equal(es.calls, calls, 'Elasticsearch was still called during the outage (each request would wait for it)');
    assert.equal(await search.recoverSearch(), false);

    es.down = false;
    assert.equal(await search.recoverSearch(), true);
    assert.equal(search.searchEngine(), 'elasticsearch');
    assert.notEqual(liveBuild(), before, 'writes skipped during the outage need a rebuild');
    assert.equal((await search.searchProducts({ q: 'galaxy' })).engine, 'elasticsearch');
  });

  test('"did you mean" shows corrections, never completions of the word being typed', () => {
    const reply = (text) => ({ suggest: { correction: [{ options: text ? [{ text }] : [] }] } });
    assert.equal(search.readCorrection('samsng galxy', reply('samsung galaxy')), 'samsung galaxy');
    assert.equal(search.readCorrection('Samsng', reply('samsung')), 'samsung');
    assert.equal(search.readCorrection('samsung gala', reply('samsung galaxy')), null);
    assert.equal(search.readCorrection('perfume', reply(null)), null);
  });

  test('Elasticsearch down at startup: MongoDB search, then switched over once it answers', async () => {
    es.down = true;
    assert.equal(await search.initSearch(), 'mongodb');
    es.down = false;
    assert.equal(await search.recoverSearch(), true);
    assert.ok(liveBuild(), 'recovery did not build the index');
  });
});
