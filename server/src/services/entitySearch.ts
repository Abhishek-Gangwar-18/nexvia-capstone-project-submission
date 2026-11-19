import mongoose from 'mongoose';
import { env } from '../config/env.ts';
import { supportsTransactions } from '../config/db.ts';
import { User } from '../models/User.ts';
import { Vendor } from '../models/Vendor.ts';
import { withLock } from './locks.ts';
import { onSearchRecovered, reportSearchError, searchClient } from './search.ts';
import { logger } from '../utils/logger.ts';

/**
 * Elasticsearch for the people side of the app: stores (public store search, admin vendors) and users
 * (admin users, admin order search by customer). Fuzzy and prefix matching, so typos and half-typed words
 * find the right record. Search returns ids best-first; callers apply their own filters in MongoDB.
 * MongoDB stays the source of truth: change streams re-index every write, startup and recovery rebuild.
 */
// Bumped when phone and GSTIN fields were removed from indexed entity documents.
const VERSION = 3;

const ANALYSIS = {
  analysis: {
    analyzer: { name_text: { type: 'custom', tokenizer: 'standard', filter: ['lowercase', 'asciifolding'] } },
    normalizer: { lower: { type: 'custom', filter: ['lowercase', 'asciifolding'] } },
  },
};
const text = { type: 'text', analyzer: 'name_text' };
const exact = { type: 'keyword', normalizer: 'lower' };

const ENTITIES = {
  vendors: {
    model: Vendor,
    load: (filter) => Vendor.find(filter).populate('user', 'name email').select('storeName tagline email phone gstin address user').lean(),
    toDoc: (v) => ({
      storeName: v.storeName,
      tagline: v.tagline || '',
      email: v.email || '',
      // Admin-only exact matches; the public store search below never looks at them.
      phone: v.phone || '',
      gstin: v.gstin || '',
      place: [v.address?.city, v.address?.state].filter(Boolean).join(' '),
      ownerName: v.user?.name || '',
      ownerEmail: v.user?.email || '',
    }),
    mappings: {
      properties: {
        storeName: { ...text, fields: { keyword: exact } },
        tagline: text,
        email: { ...exact, fields: { text } },
        phone: exact,
        gstin: exact,
        place: text,
        ownerName: text,
        ownerEmail: { ...exact, fields: { text } },
      },
    },
    fuzzyFields: ['storeName^4', 'ownerName^2', 'tagline', 'place', 'email.text', 'ownerEmail.text'],
    prefixField: 'storeName',
    exactFields: ['email', 'ownerEmail', 'storeName.keyword', 'phone', 'gstin'],
    /** Shoppers' store search: only what a store page shows, so an owner's email or phone can't be probed. */
    public: { fuzzyFields: ['storeName^4', 'tagline', 'place'], exactFields: ['storeName.keyword'] },
  },
  users: {
    model: User,
    load: (filter) => User.find(filter).select('name email').lean(),
    toDoc: (u) => ({ name: u.name, email: u.email }),
    mappings: {
      properties: {
        name: text,
        email: { ...exact, fields: { text } },
      },
    },
    fuzzyFields: ['name^3', 'email.text'],
    prefixField: 'name',
    exactFields: ['email'],
  },
};

const indexName = (entity) => `${env.elastic.index}-${entity}`;

async function writeDocs(client, entity, docs, missing = []) {
  const index = indexName(entity);
  const operations = docs.flatMap((d) => [{ index: { _index: index, _id: String(d._id) } }, ENTITIES[entity].toDoc(d)]);
  missing.forEach((id) => operations.push({ delete: { _index: index, _id: String(id) } }));
  if (operations.length) await client.bulk({ operations, refresh: false }, { requestTimeout: 60 * 1000 });
}

/** Re-indexes the given records (removed ones are deleted from the index). Fire-and-forget safe. */
export async function indexEntities(entity, ids) {
  const client = searchClient();
  const list = [...new Set([ids].flat().filter(Boolean).map(String))];
  if (!client || !list.length) return;
  try {
    const docs = await ENTITIES[entity].load({ _id: { $in: list } });
    const found = new Set(docs.map((d) => String(d._id)));
    await writeDocs(client, entity, docs, list.filter((id) => !found.has(id)));
  } catch (err) {
    reportSearchError(err, `Indexing ${entity}`);
  }
}

/** Builds an index from scratch (drop + create + bulk load). One build per entity at a time. */
async function buildIndex(client, entity) {
  return withLock(`search:${entity}`, 5 * 60, `A ${entity} reindex is already running`, async () => {
    const index = indexName(entity);
    await client.indices.delete({ index, ignore_unavailable: true });
    await client.indices.create({ index, settings: ANALYSIS, mappings: { ...ENTITIES[entity].mappings, _meta: { version: VERSION } } });
    const docs = await ENTITIES[entity].load({});
    for (let i = 0; i < docs.length; i += 500) await writeDocs(client, entity, docs.slice(i, i + 500));
    await client.indices.refresh({ index });
    logger.ok(`Elasticsearch: indexed ${docs.length} ${entity} into "${index}"`);
    return docs.length;
  });
}

/** Startup (and after an outage): builds each index that is missing, outdated or out of step with MongoDB. */
export async function syncEntityIndexes({ force = false }: Record<string, any> = {}) {
  const client = searchClient();
  if (!client) return;
  for (const entity of Object.keys(ENTITIES)) {
    try {
      const index = indexName(entity);
      let reason = force ? 'rebuild' : null;
      if (!reason) {
        const exists = await client.indices.exists({ index });
        if (!exists) reason = 'no index yet';
        else {
          const mapping = await client.indices.getMapping({ index });
          const version = mapping[index]?.mappings?._meta?.version ?? 0;
          const [{ count }, total] = await Promise.all([client.count({ index }), ENTITIES[entity].model.countDocuments()]);
          if (version !== VERSION) reason = `version ${version} -> ${VERSION}`;
          else if (count !== total) reason = `${count} documents for ${total} ${entity}`;
        }
      }
      if (reason) {
        logger.info(`Elasticsearch: building the ${entity} index (${reason})`);
        await buildIndex(client, entity);
      }
    } catch (err) {
      if (err.status === 409) continue; // another instance is building it
      reportSearchError(err, `Syncing the ${entity} index`);
    }
  }
}

/**
 * Ids of records matching typed text, best match first: exact email/phone/GSTIN, then name prefixes, then
 * fuzzy (typo tolerant) matches. Null when Elasticsearch can't answer: callers fall back to MongoDB.
 */
export async function searchEntityIds(entity, q, { size = 500, publicOnly = false }: Record<string, any> = {}) {
  const client = searchClient();
  const text = String(q || '').trim().slice(0, 100);
  if (!client || !text) return null;
  const config = ENTITIES[entity];
  if (publicOnly && !config.public) throw new Error(`No public search for ${entity}`);
  const { fuzzyFields, exactFields } = publicOnly ? config.public : config;
  const { prefixField } = config;
  try {
    const res = await client.search({
      index: indexName(entity),
      size,
      _source: false,
      query: {
        bool: {
          should: [
            ...exactFields.map((field) => ({ term: { [field]: { value: text.toLowerCase(), boost: 10 } } })),
            { match_phrase_prefix: { [prefixField]: { query: text, boost: 5 } } },
            { multi_match: { query: text, fields: fuzzyFields, fuzziness: 'AUTO', prefix_length: 1 } },
          ],
          minimum_should_match: 1,
        },
      },
    });
    return res.hits.hits.map((h) => h._id);
  } catch (err) {
    reportSearchError(err, `Searching ${entity}`);
    return null;
  }
}

/** Keeps both indices in step with MongoDB: any store or user write is re-indexed (needs a replica set). */
export function watchEntityChanges() {
  if (!supportsTransactions()) return;
  const watch = (model, onChange, label) => {
    const open = () => {
      const stream = model.watch([{ $match: { operationType: { $in: ['insert', 'update', 'replace', 'delete'] } } }, { $project: { documentKey: 1 } }]);
      stream.on('change', (change) => onChange(String(change.documentKey._id)).catch(() => {}));
      stream.on('error', (err) => {
        logger.warn(`${label} search sync: change stream error (${err.message}) -> reconnecting in 5s`);
        stream.close().catch(() => {});
        setTimeout(open, 5000).unref();
      });
    };
    open();
  };
  watch(Vendor, (id) => indexEntities('vendors', id), 'Store');
  watch(
    User,
    async (id) => {
      await indexEntities('users', id);
      // A store document carries its owner's name and email: re-index the owner's store too.
      const store = await Vendor.findOne({ user: id }).select('_id').lean();
      if (store) await indexEntities('vendors', store._id);
    },
    'User',
  );
}

onSearchRecovered(() => syncEntityIndexes({ force: true }));

/** Search ids (strings) as ObjectIds, for $in and $indexOfArray. */
export const toObjectIds = (ids) => ids.map((id) => new mongoose.Types.ObjectId(id));

/**
 * One page of `filter` restricted to the search hits, in search-rank order (best match first).
 * `query(ids)` loads the page's documents; their order is restored here.
 */
export async function pageByRank(model, filter, ids, { skip, limit, query }) {
  const matching = await model.find({ ...filter, _id: { $in: toObjectIds(ids) } }).select('_id').lean();
  const allowed = new Set(matching.map((d) => String(d._id)));
  const ranked = ids.filter((id) => allowed.has(id));
  const pageIds = ranked.slice(skip, skip + limit);
  const docs = await query(pageIds);
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  return { items: pageIds.map((id) => byId.get(id)).filter(Boolean), total: ranked.length };
}
