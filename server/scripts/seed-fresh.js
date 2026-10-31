/**
 * Fresh reseed with every image on S3.
 *
 *   1. Wipes everything: every MongoDB collection, the app's images in the S3 bucket (products/, stores/,
 *      avatars/, reviews/, returns/), and every Redis key (cache, sessions, rate limits).
 *      Admin accounts are the only thing carried over (same email and password); log in again afterwards.
 *   2. Seeds the same marketplace as `pnpm seed` (stores, customers, products, reviews, coupons, orders).
 *   3. Starts the API inside this process, signs in as each seller through POST /auth/login and uploads
 *      that seller's product images through POST /uploads?folder=products, so they land in S3 exactly
 *      like an upload from the Seller Hub. Products, categories and order lines then point at S3.
 *   4. Rebuilds indexes and the Elasticsearch index.
 *
 * Stop the API server (pnpm dev) first. Needs S3 configured in server/.env.
 * Run: pnpm seed:fresh --yes            (without --yes it only prints what it would do)
 *      pnpm seed:fresh --yes --live     (re-downloads the product catalog from dummyjson.com first)
 */
import mongoose from 'mongoose';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { env, isProd } from '../src/config/env.js';
import { connectDB } from '../src/config/db.js';
import { initCache, cache } from '../src/services/cache.js';
import { initSearch, reindexAll, searchEngine } from '../src/services/search.js';
import { deleteFile, storageDriver } from '../src/services/storage.js';
import { createApp } from '../src/app.js';
import { seedDatabase, DEMO_ACCOUNTS } from '../src/seed/seed.js';
import { User } from '../src/models/User.js';
import { Vendor } from '../src/models/Vendor.js';
import { Product } from '../src/models/Product.js';
import { Category } from '../src/models/Category.js';
import { Order } from '../src/models/Order.js';

const FOLDERS = ['products', 'stores', 'avatars', 'reviews', 'returns'];
const FILES_PER_REQUEST = 8; // the upload route's limit (middleware/upload.js)
const DOWNLOADS_AT_ONCE = 6;

const { aws } = env;
const step = (msg) => console.log(`\n\x1b[36m▸ ${msg}\x1b[0m`);
const info = (msg) => console.log(`  ${msg}`);

/** Same public URL base storage.js builds for S3 keys. */
const s3Base = () => {
  if (aws.publicUrl) return `${aws.publicUrl}/`;
  if (aws.endpoint) return `${aws.endpoint.replace(/\/$/, '')}/${aws.bucket}/`;
  return `https://${aws.bucket}.s3.${aws.region}.amazonaws.com/`;
};

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

/** Runs fn over items with at most `limit` in flight; results keep the input order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/* ------------------------------------------------------------------ wipe */

/** S3 keys of this app's images that the database points at (works without s3:ListBucket). */
async function referencedKeys() {
  const base = s3Base();
  const pattern = new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}((?:${FOLDERS.join('|')})/[^"\\s?#]+)`, 'g');
  const keys = new Set();
  for (const { name } of await mongoose.connection.db.listCollections().toArray()) {
    if (name.startsWith('system.')) continue;
    for await (const doc of mongoose.connection.db.collection(name).find()) {
      for (const match of JSON.stringify(doc).matchAll(pattern)) keys.add(match[1]);
    }
  }
  return keys;
}

/** Every key under the app's folders, when the credentials may list the bucket; null when they may not. */
async function listedKeys() {
  const s3 = new S3Client({
    region: aws.region,
    endpoint: aws.endpoint || undefined,
    forcePathStyle: aws.forcePathStyle,
    credentials: { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey },
  });
  const keys = new Set();
  try {
    for (const folder of FOLDERS) {
      let ContinuationToken;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: aws.bucket, Prefix: `${folder}/`, ContinuationToken }));
        (page.Contents || []).forEach((o) => keys.add(o.Key));
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
    }
    return keys;
  } catch (err) {
    if (err.name === 'AccessDenied' || err.$metadata?.httpStatusCode === 403) return null;
    throw err;
  }
}

async function wipe() {
  step('Collecting the app images in S3');
  const keys = await referencedKeys();
  info(`${keys.size} image(s) referenced by the database`);
  const listed = await listedKeys();
  if (listed) {
    listed.forEach((k) => keys.add(k));
    info(`${listed.size} image(s) found by listing the bucket folders`);
  } else {
    info('Bucket listing not allowed for these credentials -> deleting only the images the database references');
  }

  // Admins are the owner's own accounts (no admin is ever seeded): keep the documents as they are.
  const admins = await User.collection.find({ role: 'admin' }).toArray();

  step('Dropping every MongoDB collection');
  const collections = (await mongoose.connection.db.listCollections().toArray()).filter((c) => !c.name.startsWith('system.'));
  for (const { name } of collections) await mongoose.connection.db.dropCollection(name);
  info(`${collections.length} collection(s) dropped`);

  step('Deleting the old images from S3');
  const results = await mapLimit([...keys], 10, (key) => deleteFile(key));
  const deleted = results.filter(Boolean).length;
  info(`${deleted} deleted${deleted < keys.size ? `, ${keys.size - deleted} skipped (not an app upload key, or the delete failed)` : ''}`);

  step('Clearing Redis (cache, sessions, rate limits)');
  await cache.delPattern('*');
  return admins;
}

/* ---------------------------------------------------------------- upload */

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { buffer: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || 'application/octet-stream' };
    } catch (err) {
      if (attempt >= 3) throw new Error(`download ${url} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

async function api(base, path, { token, ...init } = {}) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...(init.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${res.status} ${body.message || ''}`);
  return body;
}

/** Signs in as each seller and uploads their product images through the API. Returns old URL -> S3 URL. */
async function uploadProductImages(base) {
  const vendors = await Vendor.find().select('storeName email user').lean();
  const urlMap = new Map();
  const failures = [];

  for (const vendor of vendors) {
    const { accessToken } = await api(base, '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: vendor.email, password: DEMO_ACCOUNTS.vendor.password }),
    });

    const products = await Product.find({ vendor: vendor._id }).select('images thumbnail').lean();
    const urls = [...new Set(products.flatMap((p) => [p.thumbnail, ...p.images.map((i) => i.url)]).filter((u) => u && !urlMap.has(u)))];

    let done = 0;
    for (const batch of chunk(urls, FILES_PER_REQUEST)) {
      const files = await mapLimit(batch, DOWNLOADS_AT_ONCE, async (url) => {
        try {
          return { url, ...(await download(url)) };
        } catch (err) {
          failures.push(err.message);
          return null;
        }
      });
      const ready = files.filter(Boolean);
      if (!ready.length) continue;

      const form = new FormData();
      ready.forEach((f, i) => form.append('images', new Blob([f.buffer], { type: f.type }), `${i}-${f.url.split('/').pop()}`));
      const { files: stored } = await api(base, '/uploads?folder=products', { method: 'POST', token: accessToken, body: form });
      ready.forEach((f, i) => urlMap.set(f.url, stored[i].url));
      done += ready.length;
    }
    info(`${vendor.storeName.padEnd(22)} ${done} image(s) uploaded for ${products.length} products`);
  }
  return { urlMap, failures };
}

/** Points products, categories and order lines at the uploaded copies. */
async function relink(urlMap) {
  const swap = (url) => urlMap.get(url) || url;

  const products = await Product.collection.find({}, { projection: { images: 1, thumbnail: 1 } }).toArray();
  await Product.collection.bulkWrite(
    products.map((p) => ({
      updateOne: { filter: { _id: p._id }, update: { $set: { thumbnail: swap(p.thumbnail), images: p.images.map((img) => ({ ...img, url: swap(img.url) })) } } },
    })),
  );

  const categories = await Category.collection.find({ image: { $exists: true } }, { projection: { image: 1 } }).toArray();
  if (categories.length) {
    await Category.collection.bulkWrite(categories.map((c) => ({ updateOne: { filter: { _id: c._id }, update: { $set: { image: swap(c.image) } } } })));
  }

  const orders = await Order.collection.find({}, { projection: { packages: 1 } }).toArray();
  await Order.collection.bulkWrite(
    orders.map((o) => ({
      updateOne: {
        filter: { _id: o._id },
        update: { $set: { packages: o.packages.map((pkg) => ({ ...pkg, items: pkg.items.map((item) => ({ ...item, image: swap(item.image) })) })) } },
      },
    })),
  );
  info(`${products.length} products, ${categories.length} categories and ${orders.length} orders now use the S3 images`);
}

/* ------------------------------------------------------------------- run */

async function main() {
  const live = process.argv.includes('--live');
  // Never wipe a production database by accident (a production server/.env on a laptop, a wrong shell).
  if (isProd && !process.argv.includes('--production')) {
    throw new Error('NODE_ENV is production: refusing to wipe it. Add --production as well if you really mean to - nothing was changed');
  }
  if (!process.argv.includes('--yes')) {
    console.log(`This permanently deletes ALL data in the database, every app image in the S3 bucket "${aws.bucket || '(not set)'}"`);
    console.log('and every Redis key, then reseeds with all images uploaded to S3 through the API. Admin accounts are kept.');
    console.log('\nStop the API server first, then run:  pnpm seed:fresh --yes');
    return;
  }
  if (storageDriver() !== 's3') throw new Error('S3 is not configured in server/.env (AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) - nothing was changed');

  await connectDB({ retries: 30 });
  await initCache();
  await initSearch();

  const admins = await wipe();

  step('Seeding the marketplace');
  // Restored before seeding, so the seed keeps them and refuses an admin email that clashes with a seeded user.
  if (admins.length) await User.collection.insertMany(admins);
  info(`${admins.length} admin account(s) kept: ${admins.map((a) => a.email).join(', ') || '-'}`);
  await seedDatabase({ live, log: info });

  step('Uploading product images to S3 through the API');
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let result;
  try {
    result = await uploadProductImages(base);
  } finally {
    server.close();
  }
  await relink(result.urlMap);

  step('Rebuilding indexes');
  for (const model of Object.values(mongoose.models)) await model.createIndexes();
  if (searchEngine() === 'elasticsearch') {
    await reindexAll();
    info('Elasticsearch index rebuilt');
  }
  await cache.delPattern('*'); // logins and pages cached while seeding

  console.log(`\n\x1b[32m✔ Fresh data ready: ${result.urlMap.size} images in S3 bucket "${aws.bucket}"\x1b[0m`);
  if (result.failures.length) {
    console.log(`\x1b[33m! ${result.failures.length} image(s) could not be downloaded and keep their original URL:\x1b[0m`);
    result.failures.slice(0, 10).forEach((f) => info(f));
  }
  console.log(`\nSellers: password ${DEMO_ACCOUNTS.vendor.password}   Customers: password ${DEMO_ACCOUNTS.customer.password}`);
  console.log('Admins: same email and password as before. Everyone has to log in again.');
}

main()
  .catch((err) => {
    console.error('\n\x1b[31mFresh seed failed:\x1b[0m', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
    process.exit();
  });
