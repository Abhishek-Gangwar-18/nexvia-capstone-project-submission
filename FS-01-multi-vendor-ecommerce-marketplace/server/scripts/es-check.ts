/**
 * Live check of the Elasticsearch in ELASTICSEARCH_NODE: the analyzers and synonyms, and the app's real search
 * and typeahead queries, run on a few sample products in a temporary index that is deleted at the end.
 * Then reports the live index behind the alias. MongoDB is not touched.
 * Run: pnpm es:check
 */
import { Client } from '@elastic/elasticsearch';
import { env } from '../src/config/env.ts';
import {
  ALIAS,
  buildSuggestRequest,
  INDEX_VERSION,
  MAPPINGS,
  normalizeSearchParams,
  readCorrection,
  runSearch,
  SETTINGS,
  toDoc,
} from '../src/services/search.ts';

let failed = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}${detail ? ` (${detail})` : ''}`);
  } catch (err) {
    failed += 1;
    console.log(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
  }
}
const expect = (ok, message) => {
  if (!ok) throw new Error(message);
};

if (!env.elastic.node) {
  console.log('ELASTICSEARCH_NODE is not set in server/.env');
  process.exit(1);
}
const { apiKey, username, password } = env.elastic;
const es = new Client({ node: env.elastic.node, auth: apiKey ? { apiKey } : username ? { username, password } : undefined, requestTimeout: 10000 });

try {
  const info = await es.info();
  console.log(`\nElasticsearch ${info.version.number} at ${env.elastic.node} (cluster "${info.cluster_name}")`);
} catch (err) {
  console.log(`\nCould not reach Elasticsearch at ${env.elastic.node}: ${err.message}`);
  console.log(' -> Start it with: docker compose up -d elasticsearch (it needs ~30 s to boot)');
  process.exit(1);
}

/* Sample catalog: one store, seven categories, one product from a suspended store that must never show up. */
const id = (n) => n.toString(16).padStart(24, '0');
const CATS = { phones: id(1), laptops: id(2), audio: id(3), shoes: id(4), tops: id(5), appliances: id(6), tvs: id(7) };
const names = new Map([
  [CATS.phones, 'Smartphones'],
  [CATS.laptops, 'Laptops'],
  [CATS.audio, 'Audio'],
  [CATS.shoes, 'Footwear'],
  [CATS.tops, 'Tops'],
  [CATS.appliances, 'Home Appliances'],
  [CATS.tvs, 'Televisions'],
]);
const store = { _id: id(100), storeName: 'Check Store', status: 'approved' };
const product = (n, title, brand, category, price, extra: Record<string, any> = {}) => ({
  _id: id(200 + n), title, brand, category, price, mrp: price, stock: 10, sold: 10 * n, isActive: true,
  vendor: store, createdAt: new Date(Date.now() - n * 1000), ...extra,
});
const PRODUCTS = [
  product(1, 'Samsung Galaxy S24 Ultra 5G', 'Samsung', CATS.phones, 129999),
  product(2, 'Apple MacBook Air M3 13-inch', 'Apple', CATS.laptops, 114900, { specs: [{ label: 'RAM', value: '16GB' }] }),
  product(3, 'boAt Airdopes 141 Wireless Earbuds', 'boAt', CATS.audio, 1299),
  product(4, 'Nike Air Zoom Pegasus Running Shoes', 'Nike', CATS.shoes, 8995),
  product(5, "Men's Cotton Crew Neck T-Shirt", 'Roadster', CATS.tops, 499),
  product(6, 'LG 1.5 Ton 5 Star Split Inverter AC', 'LG', CATS.appliances, 46990),
  product(7, 'Sony Bravia 55 inch 4K Smart Television', 'Sony', CATS.tvs, 57990),
  product(8, 'Samsung Galaxy S23 FE', 'Samsung', CATS.phones, 39999, { vendor: { ...store, status: 'suspended' } }),
];

const index = `vendora-check-${Date.now()}`;
const search = (raw) => runSearch(es, normalizeSearchParams(raw), index);
const titles = (result) => result.items.map((p) => p.title);
const top = async (q, expected) => {
  const result = await search({ q });
  expect(result.total > 0, `no results for "${q}"`);
  expect(titles(result)[0].includes(expected), `first result for "${q}" was "${titles(result)[0]}"`);
  return `${result.total} hit${result.total > 1 ? 's' : ''}, first: ${titles(result)[0]}`;
};

console.log('\nSearch checks (temporary index with 8 sample products):');
try {
  await check('the index builds with the app settings, analyzers and synonyms', async () => {
    await es.indices.create({ index, settings: SETTINGS, mappings: MAPPINGS } as any);
    const res = await es.bulk({ refresh: true, operations: PRODUCTS.flatMap((p) => [{ index: { _index: index, _id: p._id } }, toDoc(p, names)]) });
    expect(!res.errors, `bulk errors: ${JSON.stringify(res.items.find((i) => i.index.error)?.index.error)}`);
  });
  await check('typo: "samsng galaxy" finds the S24', () => top('samsng galaxy', 'Galaxy S24'));
  await check('a product of a suspended store never shows', async () => {
    const result = await search({ q: 'samsung' });
    expect(!titles(result).some((t) => t.includes('S23')), 'the suspended store\'s S23 was returned');
    return `${result.total} hit`;
  });
  await check('words in different fields: "samsung mobile" (brand + category synonym)', async () => {
    const result = await search({ q: 'samsung mobile' });
    expect(result.total === 1 && titles(result)[0].includes('S24'), `got ${titles(result).join(', ') || 'nothing'}`);
    return 'S24 only';
  });
  await check('synonym: "phones" finds smartphones', () => top('phones', 'Galaxy S24'));
  await check('synonym: "tv" finds the television', () => top('tv', 'Sony Bravia'));
  await check('synonym: "tshirt" finds the T-Shirt', () => top('tshirt', 'T-Shirt'));
  await check('synonym: "air conditioner" finds the split AC', () => top('air conditioner', 'Split Inverter AC'));
  await check('synonym: "earphones" finds earbuds', () => top('earphones', 'Airdopes'));
  await check('specs are searchable: "macbook 16gb"', () => top('macbook 16gb', 'MacBook'));
  await check('typo: "macbok"', () => top('macbok', 'MacBook'));
  await check('no product has every word: "nike earbuds" shows partial matches, flagged', async () => {
    const result: Record<string, any> = await search({ q: 'nike earbuds' });
    expect(result.relaxed === true && result.total === 2, `relaxed=${result.relaxed}, ${result.total} hits`);
    return titles(result).join(' + ');
  });
  await check('brand filter keeps the other brands in the facet', async () => {
    const result = await search({ brand: 'Samsung,Apple' });
    expect(result.total === 2, `${result.total} hits`);
    expect(result.facets.brands.length === 7, `${result.facets.brands.length} brands in the facet`);
    return `price range ₹${result.facets.price.min}–₹${result.facets.price.max}`;
  });
  await check('sort by price, low to high', async () => {
    const result = await search({ sort: 'price_asc' });
    expect(titles(result)[0].includes('T-Shirt'), `first was ${titles(result)[0]}`);
  });
  await check('typeahead: "gala" and "macbok ai"', async () => {
    const suggestions = async (q) => (await es.search<{ title: string }>(buildSuggestRequest(q, { index }))).hits.hits.map((h) => h._source.title);
    const [gala, mac] = await Promise.all([suggestions('gala'), suggestions('macbok ai')]);
    expect(gala[0]?.includes('Galaxy S24'), `"gala" suggested ${gala.join(', ') || 'nothing'}`);
    expect(mac[0]?.includes('MacBook'), `"macbok ai" suggested ${mac.join(', ') || 'nothing'}`);
    return `${gala[0]}, ${mac[0]}`;
  });
  await check('did you mean: corrects typos, never completions or correct words', async () => {
    const correction = async (q) => readCorrection(q, await es.search(buildSuggestRequest(q, { index })));
    const [typo, twoTypos, completion, correct] = await Promise.all([correction('samsng'), correction('samsng galxy'), correction('gala'), correction('samsung')]);
    expect(typo === 'samsung', `"samsng" -> ${typo}`);
    expect(twoTypos === 'samsung galaxy', `"samsng galxy" -> ${twoTypos}`);
    expect(completion === null, `"gala" -> ${completion} (a completion, not a correction)`);
    expect(correct === null, `"samsung" -> ${correct}`);
    return `samsng -> ${typo}, samsng galxy -> ${twoTypos}`;
  });
} finally {
  await es.indices.delete({ index }).catch(() => {});
}

console.log(`\nLive index (alias "${ALIAS}"):`);
await check('built by the API and up to date', async () => {
  let mapping;
  try {
    mapping = await es.indices.getMapping({ index: ALIAS });
  } catch (err) {
    if (err.meta?.statusCode === 404) throw new Error('not built yet -> start (or restart) the API; it builds the index on startup');
    throw err;
  }
  const [build] = Object.keys(mapping);
  const version = mapping[build].mappings?._meta?.version ?? 0;
  expect(version === INDEX_VERSION, `${build} is version ${version}, the code expects ${INDEX_VERSION} -> restart the API to rebuild`);
  const { count } = await es.count({ index: ALIAS });
  return `${build}, ${count} products`;
});

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll Elasticsearch checks passed.');
process.exit(failed ? 1 : 0);
