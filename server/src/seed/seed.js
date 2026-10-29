/**
 * Seeds the marketplace: 20 customers, 5 approved stores (vendors), 184 products from DummyJSON
 * (prices converted to INR), reviews, coupons and 90 days of order history so the vendor and
 * admin dashboards have data to chart.
 *
 * No admin account is created - the platform owner creates their own. Existing admin accounts
 * are left untouched on every run (only the old demo admin from earlier versions is removed).
 *
 * Run: npm run seed            (uses the bundled DummyJSON snapshot)
 *      npm run seed -- --live  (re-downloads products from https://dummyjson.com first)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { Vendor } from '../models/Vendor.js';
import { Category } from '../models/Category.js';
import { Product } from '../models/Product.js';
import { Review } from '../models/Review.js';
import { Rating } from '../models/Rating.js';
import { ReviewVote } from '../models/ReviewVote.js';
import { Order } from '../models/Order.js';
import { Coupon } from '../models/Coupon.js';
import { CouponRedemption } from '../models/CouponRedemption.js';
import { Cart } from '../models/Cart.js';
import { Settings } from '../models/Settings.js';
import { Session } from '../models/Session.js';
import { round2 } from '../utils/http.js';
import { RETURN_WINDOW_DAYS } from '../services/payouts.js';

const __filename = fileURLToPath(import.meta.url);
const SNAPSHOT = path.join(path.dirname(__filename), 'data', 'dummyjson-products.json');

export const DEMO_ACCOUNTS = {
  customer: { email: 'customer@vendora.dev', password: 'Customer@123' },
  vendor: { email: 'technova@vendora.dev', password: 'Vendor@123' },
};

/** Admin account created by earlier versions of this seed; removed so the owner is the only admin. */
const LEGACY_DEMO_ADMIN = 'admin@vendora.dev';

const DAY = 24 * 60 * 60 * 1000;
const EXCLUDED_CATEGORIES = ['vehicle', 'motorcycle'];

const CATEGORY_META = {
  smartphones: { name: 'Smartphones', group: 'Electronics' },
  laptops: { name: 'Laptops', group: 'Electronics' },
  tablets: { name: 'Tablets', group: 'Electronics' },
  'mobile-accessories': { name: 'Mobile Accessories', group: 'Electronics' },
  'mens-shirts': { name: "Men's Shirts", group: 'Fashion' },
  tops: { name: 'Tops', group: 'Fashion' },
  'womens-dresses': { name: "Women's Dresses", group: 'Fashion' },
  'mens-shoes': { name: "Men's Shoes", group: 'Fashion' },
  'womens-shoes': { name: "Women's Shoes", group: 'Fashion' },
  'womens-bags': { name: "Women's Bags", group: 'Fashion' },
  'womens-jewellery': { name: "Women's Jewellery", group: 'Fashion' },
  sunglasses: { name: 'Sunglasses', group: 'Fashion' },
  'mens-watches': { name: "Men's Watches", group: 'Fashion' },
  'womens-watches': { name: "Women's Watches", group: 'Fashion' },
  beauty: { name: 'Beauty', group: 'Beauty' },
  fragrances: { name: 'Fragrances', group: 'Beauty' },
  'skin-care': { name: 'Skin Care', group: 'Beauty' },
  furniture: { name: 'Furniture', group: 'Home' },
  'home-decoration': { name: 'Home Decor', group: 'Home' },
  'kitchen-accessories': { name: 'Kitchen', group: 'Home' },
  groceries: { name: 'Groceries', group: 'Grocery' },
  'sports-accessories': { name: 'Sports & Fitness', group: 'Sports' },
};

const STORES = [
  {
    storeName: 'TechNova Electronics', owner: 'Arjun Mehta', email: 'technova@vendora.dev', houseBrand: 'TechNova',
    tagline: 'Flagship phones, laptops & smart gadgets', city: 'Bengaluru', state: 'Karnataka', commissionRate: 8,
    categories: ['smartphones', 'laptops', 'tablets', 'mobile-accessories'],
  },
  {
    storeName: 'Urban Threads', owner: 'Priya Sharma', email: 'urbanthreads@vendora.dev', houseBrand: 'Urban Threads',
    tagline: 'Clothing, footwear & bags for every day', city: 'Mumbai', state: 'Maharashtra',
    categories: ['mens-shirts', 'tops', 'womens-dresses', 'mens-shoes', 'womens-shoes', 'womens-bags'],
  },
  {
    storeName: 'Glow & Co.', owner: 'Riya Kapoor', email: 'glow@vendora.dev', houseBrand: 'Glow & Co.',
    tagline: 'Beauty, fragrances, watches & jewellery', city: 'New Delhi', state: 'Delhi', commissionRate: 12,
    categories: ['beauty', 'fragrances', 'skin-care', 'womens-jewellery', 'mens-watches', 'womens-watches', 'sunglasses'],
  },
  {
    storeName: 'Casa Living', owner: 'Rahul Bansal', email: 'casa@vendora.dev', houseBrand: 'Casa',
    tagline: 'Furniture, decor and kitchen essentials', city: 'Jaipur', state: 'Rajasthan',
    categories: ['furniture', 'home-decoration', 'kitchen-accessories'],
  },
  {
    storeName: 'FreshCart Daily', owner: 'Deepak Kulkarni', email: 'freshcart@vendora.dev', houseBrand: 'FreshCart',
    tagline: 'Groceries, fitness gear & daily essentials', city: 'Pune', state: 'Maharashtra', commissionRate: 5,
    categories: ['groceries', 'sports-accessories'],
  },
];

/** [name, email, city, state, pincode] - all customers share the password in DEMO_ACCOUNTS.customer. */
const CUSTOMERS = [
  ['Aarav Patel', 'customer@vendora.dev', 'Ahmedabad', 'Gujarat', '380015'],
  ['Ananya Gupta', 'ananya.gupta@example.com', 'Lucknow', 'Uttar Pradesh', '226001'],
  ['Rohan Verma', 'rohan.verma@example.com', 'Indore', 'Madhya Pradesh', '452001'],
  ['Isha Reddy', 'isha.reddy@example.com', 'Hyderabad', 'Telangana', '500081'],
  ['Vikram Singh', 'vikram.singh@example.com', 'Jaipur', 'Rajasthan', '302001'],
  ['Neha Joshi', 'neha.joshi@example.com', 'Pune', 'Maharashtra', '411001'],
  ['Karan Malhotra', 'karan.malhotra@example.com', 'Gurugram', 'Haryana', '122002'],
  ['Sneha Nair', 'sneha.nair@example.com', 'Kochi', 'Kerala', '682016'],
  ['Aditya Rao', 'aditya.rao@example.com', 'Mysuru', 'Karnataka', '570001'],
  ['Pooja Desai', 'pooja.desai@example.com', 'Surat', 'Gujarat', '395003'],
  ['Rahul Kapoor', 'rahul.kapoor@example.com', 'New Delhi', 'Delhi', '110001'],
  ['Meera Pillai', 'meera.pillai@example.com', 'Chennai', 'Tamil Nadu', '600028'],
  ['Arjun Nambiar', 'arjun.nambiar@example.com', 'Thiruvananthapuram', 'Kerala', '695001'],
  ['Kavya Iyer', 'kavya.iyer@example.com', 'Coimbatore', 'Tamil Nadu', '641001'],
  ['Siddharth Jain', 'siddharth.jain@example.com', 'Bhopal', 'Madhya Pradesh', '462001'],
  ['Riya Sen', 'riya.sen@example.com', 'Kolkata', 'West Bengal', '700019'],
  ['Manav Choudhary', 'manav.choudhary@example.com', 'Chandigarh', 'Chandigarh', '160017'],
  ['Tanya Bhatia', 'tanya.bhatia@example.com', 'Noida', 'Uttar Pradesh', '201301'],
  ['Harsh Vardhan', 'harsh.vardhan@example.com', 'Patna', 'Bihar', '800001'],
  ['Fatima Sheikh', 'fatima.sheikh@example.com', 'Mumbai', 'Maharashtra', '400050'],
];

const REVIEWERS = [
  'Aditi S.', 'Rakesh K.', 'Simran B.', 'Nikhil P.', 'Divya M.', 'Farhan A.', 'Tanvi R.', 'Siddharth J.', 'Lakshmi V.',
  'Manish T.', 'Zoya H.', 'Gaurav D.', 'Shreya N.', 'Arnav C.', 'Kriti L.', 'Yash G.', 'Nisha F.', 'Varun E.',
];

const REVIEW_TEMPLATES = {
  5: [
    ['Must buy!', 'Absolutely love it. Exceeded my expectations in every way.'],
    ['Excellent quality', 'Fantastic quality for the price. Would happily recommend it to friends.'],
    ['Exactly as described', 'Exactly as described and the delivery was super quick.'],
    ['Premium feel', 'Feels premium and works perfectly. Will definitely buy again from this seller.'],
  ],
  4: [
    ['Great value', 'Very good product for the money. Packaging could have been a little better.'],
    ['Pretty good', 'Works well. Delivery took a day longer than promised but the product is solid.'],
    ['Happy with it', 'Nice quality, the colour is slightly different from the photos but I like it.'],
  ],
  3: [
    ['Okay for the price', 'Decent product that does the job. Nothing extraordinary though.'],
    ['Average', 'Average quality. Fine for occasional use.'],
  ],
  2: [['Below expectations', 'Not quite what I expected. The finish could be much better at this price.']],
  1: [['Not recommended', 'Disappointed with the quality. Had to raise a return request.']],
};

/* ---------------------------------------------------------------- helpers */

/** Small deterministic PRNG so every seed run produces the same marketplace. */
function createRandom(seed = 20241028) {
  let state = seed;
  const next = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

const toInr = (usd) => {
  const raw = usd * 83;
  const step = raw >= 10000 ? 100 : 10;
  return Math.max(49, Math.round(raw / step) * step - 1);
};

const id = () => new mongoose.Types.ObjectId();

/** Runs Mongoose casting/defaults/validation, then returns a plain document for a bulk insert (keeps our custom timestamps). */
const prepare = (Model, data) => {
  const doc = new Model(data);
  const error = doc.validateSync();
  if (error) throw error;
  return doc.toObject({ depopulate: true });
};

async function loadCatalog(live) {
  if (live) {
    const [productsRes, categoriesRes] = await Promise.all([
      fetch('https://dummyjson.com/products?limit=0'),
      fetch('https://dummyjson.com/products/categories'),
    ]);
    if (!productsRes.ok) throw new Error(`DummyJSON responded ${productsRes.status}`);
    const { products } = await productsRes.json();
    const categories = await categoriesRes.json();
    return { products, categories };
  }
  return JSON.parse(await fs.readFile(SNAPSHOT, 'utf8'));
}

/* ------------------------------------------------------------------- seed */

export async function seedDatabase({ live = false, log = console.log } = {}) {
  const rand = createRandom();
  const now = Date.now();
  const models = [User, Vendor, Category, Product, Review, Rating, ReviewVote, Order, Coupon, CouponRedemption, Cart, Settings, Session];

  // Admins are the platform owner's own accounts: keep them (except the legacy demo admin) and never seed one.
  const adminFilter = { role: 'admin', email: { $ne: LEGACY_DEMO_ADMIN } };
  const keptAdmins = await User.find(adminFilter).select('email').lean();
  const seededEmails = new Set([...STORES.map((s) => s.email), ...CUSTOMERS.map((c) => c[1])]);
  const clash = keptAdmins.find((a) => seededEmails.has(a.email));
  if (clash) throw new Error(`The admin account ${clash.email} uses an email reserved for seeded users - change one of them first`);

  log('Seeding: clearing collections (admin accounts are kept)…');
  await Promise.all(models.map((m) => (m === User ? m.deleteMany({ $nor: [adminFilter] }) : m.deleteMany({}))));
  await Promise.all(models.map((m) => m.init()));

  const catalog = await loadCatalog(live);
  const rawProducts = catalog.products.filter((p) => !EXCLUDED_CATEGORIES.includes(p.category));

  // Users ---------------------------------------------------------------
  const [vendorHash, customerHash] = await Promise.all([DEMO_ACCOUNTS.vendor.password, DEMO_ACCOUNTS.customer.password].map((pw) => bcrypt.hash(pw, 12)));
  const daysAgo = (n) => new Date(now - n * DAY);

  const users = [];
  const vendorUsers = STORES.map((s, i) =>
    prepare(User, {
      _id: id(), name: s.owner, email: s.email, password: vendorHash, role: 'vendor',
      phone: `98${String(45000000 + i * 7919).padStart(8, '0')}`, createdAt: daysAgo(180 - i * 6), updatedAt: daysAgo(2),
    }),
  );
  users.push(...vendorUsers);

  const customers = CUSTOMERS.map(([name, email, city, state, pincode], i) =>
    prepare(User, {
      _id: id(), name, email, password: customerHash, role: 'customer',
      phone: `90${String(11000000 + i * 104729).padStart(8, '0')}`,
      addresses: [
        {
          label: 'Home', fullName: name, phone: `90${String(11000000 + i * 104729).padStart(8, '0')}`,
          line1: `${rand.int(12, 480)}, ${rand.pick(['MG Road', 'Park Street', 'Lake View Residency', 'Sector 21', 'Green Avenue', 'Station Road'])}`,
          line2: rand.pick(['Near City Mall', 'Opp. Central Park', 'Behind Metro Station', '']),
          city, state, pincode, country: 'India', isDefault: true,
        },
        ...(i === 0
          ? [{ label: 'Office', fullName: name, phone: '9011000000', line1: '4th Floor, Infinity Tech Park', line2: 'SG Highway', city, state, pincode: '380054', country: 'India', isDefault: false }]
          : []),
      ],
      createdAt: daysAgo(rand.int(5, 160)), updatedAt: daysAgo(1),
    }),
  );
  users.push(...customers);

  // Vendors -------------------------------------------------------------
  const vendors = STORES.map((s, i) =>
    prepare(Vendor, {
      _id: id(), user: vendorUsers[i]._id, storeName: s.storeName, tagline: s.tagline,
      description: `${s.storeName} is a verified Vendora seller based in ${s.city}. ${s.tagline}. Every order is quality-checked and shipped within 24 hours.`,
      email: s.email, phone: vendorUsers[i].phone, gstin: `${String(10 + i).padStart(2, '0')}ABCDE${1000 + i}F1Z${i}`,
      address: { line1: `${rand.int(1, 99)}, Industrial Area Phase ${rand.int(1, 3)}`, city: s.city, state: s.state, pincode: String(400001 + i * 1111) },
      bank: { accountHolder: s.storeName, accountNumberMasked: `••••••••${String(1000 + i * 37).slice(-4)}`, ifsc: `HDFC000${String(1000 + i).slice(-4)}` },
      status: 'approved', commissionRate: s.commissionRate ?? null, approvedAt: daysAgo(170 - i * 6),
      statusHistory: [
        { status: 'pending', reason: 'Application submitted', by: vendorUsers[i]._id, at: daysAgo(175 - i * 6) },
        { status: 'approved', at: daysAgo(170 - i * 6) },
      ],
      createdAt: daysAgo(175 - i * 6), updatedAt: daysAgo(3),
    }),
  );
  const vendorByName = (name) => vendors[STORES.findIndex((s) => s.storeName === name)];

  const vendorByCategory = new Map();
  STORES.forEach((s, i) => s.categories.forEach((c) => vendorByCategory.set(c, { vendor: vendors[i], store: s })));

  // Categories ----------------------------------------------------------
  const categorySlugs = Object.keys(CATEGORY_META);
  const categories = categorySlugs.map((slug, order) =>
    prepare(Category, {
      _id: id(), order, name: CATEGORY_META[slug].name, group: CATEGORY_META[slug].group,
      image: rawProducts.find((p) => p.category === slug)?.thumbnail, createdAt: daysAgo(200), updatedAt: daysAgo(200),
    }),
  );

  // The source catalog names categories by slug; documents reference them by id.
  const categoryId = new Map(categorySlugs.map((slug, i) => [slug, categories[i]._id]));

  // Products ------------------------------------------------------------
  const products = rawProducts.map((p) => {
    const { vendor, store } = vendorByCategory.get(p.category);
    const price = toInr(p.price);
    const mrp = p.discountPercentage >= 3 ? Math.max(price, toInr(p.price / (1 - p.discountPercentage / 100))) : price;
    const createdAt = daysAgo(rand.int(0, 120) + rand.next());
    const specs = [
      p.dimensions && { label: 'Dimensions', value: `${p.dimensions.width} × ${p.dimensions.height} × ${p.dimensions.depth} cm` },
      p.warrantyInformation && { label: 'Warranty', value: p.warrantyInformation },
      p.shippingInformation && { label: 'Shipping', value: p.shippingInformation },
      p.returnPolicy && { label: 'Returns', value: p.returnPolicy },
    ].filter(Boolean);
    return prepare(Product, {
      _id: id(), vendor: vendor._id, title: p.title, description: p.description,
      brand: p.brand || store.houseBrand, category: categoryId.get(p.category), price, mrp,
      stock: rand.chance(0.04) ? 0 : Math.max(4, p.stock), sku: p.sku,
      images: p.images.map((url) => ({ url })), thumbnail: p.thumbnail, tags: p.tags || [], specs,
      sold: Math.round(Math.pow(rand.next(), 2) * 900) + rand.int(5, 40), isActive: true,
      createdAt, updatedAt: createdAt,
    });
  });

  // Reviews (DummyJSON reviews + a few generated ones) --------------------
  // These are imported reviewers without accounts: each brings one rating and one written review.
  const reviews = [];
  const ratings = [];
  products.forEach((product, index) => {
    const raw = rawProducts[index];
    raw.reviews.forEach((r) => {
      const date = new Date(Math.min(now, new Date(product.createdAt).getTime() + rand.int(1, 40) * DAY));
      ratings.push({ _id: id(), product: product._id, value: r.rating, createdAt: date, updatedAt: date });
      reviews.push(prepare(Review, { _id: id(), product: product._id, authorName: r.reviewerName, authorRating: r.rating, title: '', comment: r.comment, verified: true, createdAt: date, updatedAt: date }));
    });
    const baseRating = raw.reviews.length ? raw.reviews.reduce((s, r) => s + r.rating, 0) / raw.reviews.length : 4;
    const extra = rand.int(1, 6);
    for (let i = 0; i < extra; i++) {
      const rating = Math.min(5, Math.max(1, Math.round(Math.max(baseRating, 3.6) + (rand.next() - 0.35) * 2.2)));
      const [title, comment] = rand.pick(REVIEW_TEMPLATES[rating]);
      const date = new Date(Math.min(now, new Date(product.createdAt).getTime() + rand.int(1, 60) * DAY));
      ratings.push({ _id: id(), product: product._id, value: rating, createdAt: date, updatedAt: date });
      reviews.push(prepare(Review, { _id: id(), product: product._id, authorName: rand.pick(REVIEWERS), authorRating: rating, title, comment, verified: rand.chance(0.7), createdAt: date, updatedAt: date }));
    }
  });
  const ratingByProduct = new Map();
  ratings.forEach((r) => {
    const key = String(r.product);
    const entry = ratingByProduct.get(key) || { sum: 0, count: 0 };
    entry.sum += r.value;
    entry.count += 1;
    ratingByProduct.set(key, entry);
  });
  products.forEach((p) => {
    const entry = ratingByProduct.get(String(p._id));
    p.ratingSum = entry?.sum || 0;
    p.numRatings = entry?.count || 0;
    p.rating = entry ? round2(entry.sum / entry.count) : 0;
  });

  // Settings & coupons ----------------------------------------------------
  const settings = prepare(Settings, { key: 'platform', commissionRate: 10, shippingFee: 49, freeShippingThreshold: 999 });
  const couponDocs = [
    { code: 'WELCOME10', description: '10% off your order (up to ₹500)', type: 'percent', value: 10, maxDiscount: 500, minOrder: 999, perUserLimit: 1 },
    { code: 'FLAT250', description: '₹250 off on orders above ₹2,499', type: 'flat', value: 250, minOrder: 2499, perUserLimit: 3, usageLimit: 1000 },
    { code: 'FESTIVE20', description: 'Festive sale: 20% off (up to ₹1,500)', type: 'percent', value: 20, maxDiscount: 1500, minOrder: 4999, perUserLimit: 2, expiresAt: daysAgo(-30) },
    { code: 'TECHNOVA5', description: '5% off TechNova Electronics (up to ₹2,000)', type: 'percent', value: 5, maxDiscount: 2000, minOrder: 9999, vendor: vendorByName('TechNova Electronics')._id, perUserLimit: 2 },
    { code: 'GLOW15', description: '15% off Glow & Co. (up to ₹300)', type: 'percent', value: 15, maxDiscount: 300, minOrder: 799, vendor: vendorByName('Glow & Co.')._id, perUserLimit: 1 },
    { code: 'MONSOON30', description: 'Expired monsoon sale', type: 'percent', value: 30, maxDiscount: 1000, minOrder: 1999, expiresAt: daysAgo(10) },
  ].map((c) => prepare(Coupon, { _id: id(), ...c, createdAt: daysAgo(60), updatedAt: daysAgo(60) }));

  // Orders (90 days of history, weighted towards recent days) ----------------
  const orders = [];
  const productsByVendor = new Map();
  products.forEach((p) => {
    const key = String(p.vendor);
    productsByVendor.set(key, [...(productsByVendor.get(key) || []), p]);
  });
  const vendorById = new Map(vendors.map((v) => [String(v._id), v]));
  const welcome = couponDocs[0];
  // WELCOME10 is once per customer, so each customer redeems it at most once in the history.
  const welcomeUsers = new Set();
  const redemptions = [];

  const STAGES = ['placed', 'packed', 'shipped', 'delivered'];
  const stageForAge = (ageDays) => {
    if (ageDays > 9) return 'delivered';
    if (ageDays > 5) return rand.chance(0.6) ? 'delivered' : 'shipped';
    if (ageDays > 2) return rand.pick(['packed', 'shipped', 'shipped']);
    return rand.pick(['placed', 'placed', 'packed']);
  };

  const orderCount = 210;
  for (let n = 0; n < orderCount; n++) {
    const customer = n % 9 === 0 ? customers[0] : rand.pick(customers);
    const ageDays = Math.pow(rand.next(), 1.35) * 90;
    const placedAt = new Date(now - ageDays * DAY);
    const vendorCount = rand.chance(0.3) ? 2 : 1;
    const chosenVendors = [];
    while (chosenVendors.length < vendorCount) {
      const v = rand.pick(vendors);
      if (!chosenVendors.includes(v)) chosenVendors.push(v);
    }

    const cancelled = ageDays > 3 && rand.chance(0.05);
    const stage = cancelled ? 'cancelled' : stageForAge(ageDays);
    const packages = chosenVendors.map((v) => {
      const pool = productsByVendor.get(String(v._id));
      const lineCount = rand.int(1, Math.min(2, pool.length));
      const picked = [];
      while (picked.length < lineCount) {
        const p = rand.pick(pool);
        if (!picked.includes(p)) picked.push(p);
      }
      const items = picked.map((p) => {
        const quantity = String(p.category) === String(categoryId.get('groceries')) ? rand.int(1, 3) : rand.chance(0.15) ? 2 : 1;
        return { product: p._id, title: p.title, image: p.thumbnail, category: p.category, price: p.price, quantity, total: round2(p.price * quantity) };
      });
      const subtotal = round2(items.reduce((s, i) => s + i.total, 0));

      // Timeline: each stage roughly a day apart, never in the future.
      const reached = cancelled ? ['placed'] : STAGES.slice(0, STAGES.indexOf(stage) + 1);
      const timeline = reached.map((status, i) => ({
        status,
        at: new Date(Math.min(now - 60 * 1000, placedAt.getTime() + i * (0.6 + rand.next()) * DAY)),
        note: { placed: 'Payment received, order placed', packed: 'Seller has packed your items', shipped: 'Package handed over to the courier', delivered: 'Package delivered' }[status],
      }));
      if (cancelled) timeline.push({ status: 'cancelled', at: new Date(placedAt.getTime() + 0.4 * DAY), note: 'Cancelled by customer' });

      return {
        _id: id(), vendor: v._id, storeName: v.storeName, items, subtotal, discount: 0, status: stage, timeline,
        trackingId: ['shipped', 'delivered'].includes(stage) ? `VDX${rand.int(100000000, 999999999)}` : undefined,
      };
    });

    const subtotal = round2(packages.reduce((s, p) => s + p.subtotal, 0));
    let discount = 0;
    const orderId = id();
    if (subtotal >= welcome.minOrder && !welcomeUsers.has(String(customer._id)) && rand.chance(0.12)) {
      welcomeUsers.add(String(customer._id));
      redemptions.push({ _id: id(), coupon: welcome._id, user: customer._id, order: orderId, slot: 1, status: 'used', live: true, createdAt: placedAt, updatedAt: placedAt });
      discount = Math.min(Math.round(subtotal * 0.1), welcome.maxDiscount);
      let remaining = discount;
      packages.forEach((p, i) => {
        p.discount = i === packages.length - 1 ? remaining : round2((discount * p.subtotal) / subtotal);
        remaining = round2(remaining - p.discount);
      });
    }
    packages.forEach((p) => {
      const rate = vendorById.get(String(p.vendor)).commissionRate ?? settings.commissionRate;
      p.total = round2(p.subtotal - p.discount);
      p.commissionRate = rate;
      p.commission = round2((p.total * rate) / 100);
      p.vendorEarning = round2(p.total - p.commission);
      // Vendors are paid once the return window after delivery has passed (same rule as services/payouts.js).
      const deliveredAt = p.timeline.find((t) => t.status === 'delivered')?.at;
      const releaseAfter = deliveredAt && new Date(new Date(deliveredAt).getTime() + RETURN_WINDOW_DAYS * DAY);
      const released = !cancelled && releaseAfter && releaseAfter.getTime() <= now;
      p.payout = {
        mode: 'manual',
        status: cancelled ? 'reversed' : released ? 'released' : 'on_hold',
        ...(releaseAfter ? { releaseAfter } : {}),
        ...(released ? { releasedAt: releaseAfter, amount: p.vendorEarning } : {}),
      };
      if (cancelled) p.refund = { id: `mock_refund_${rand.int(100000, 999999)}`, amount: p.total, status: 'processed' };
    });

    const afterDiscount = subtotal - discount;
    const shipping = afterDiscount >= settings.freeShippingThreshold ? 0 : settings.shippingFee;
    const address = customer.addresses[0];
    const status = cancelled ? 'cancelled' : { placed: 'placed', packed: 'processing', shipped: 'shipped', delivered: 'delivered' }[stage];

    orders.push(
      prepare(Order, {
        _id: orderId,
        orderNumber: `VD${String(placedAt.getTime()).slice(-8)}${String(n).padStart(2, '0').slice(-2)}`,
        customer: customer._id,
        packages,
        shippingAddress: { fullName: address.fullName, phone: address.phone, line1: address.line1, line2: address.line2, city: address.city, state: address.state, pincode: address.pincode, country: 'India' },
        pricing: { subtotal, discount, shipping, total: round2(afterDiscount + shipping) },
        coupon: discount ? { id: welcome._id, code: welcome.code, discount } : undefined,
        payment: {
          provider: 'mock', status: cancelled ? 'refunded' : 'paid', intentId: `pi_test_seed${String(n).padStart(4, '0')}`,
          paymentId: `pay_test_seed${String(n).padStart(4, '0')}`, method: rand.pick(['card', 'upi', 'upi', 'netbanking', 'wallet']), paidAt: placedAt,
        },
        status,
        placedAt,
        createdAt: placedAt,
        updatedAt: placedAt,
      }),
    );
  }

  // Demo customer extras: a cart and a wishlist so the first login feels lived in.
  const demo = customers[0];
  demo.wishlist = [products[3]._id, products[40]._id, products[90]._id, products[150]._id].filter(Boolean);
  const cart = prepare(Cart, { user: demo._id, items: [{ product: products[1]._id, quantity: 1 }, { product: products[60]._id, quantity: 2 }] });

  // Store ratings: totals of the store's product ratings (same rule as recalcVendorRating).
  vendors.forEach((v) => {
    const own = products.filter((p) => String(p.vendor) === String(v._id));
    v.ratingSum = own.reduce((n, p) => n + p.ratingSum, 0);
    v.numRatings = own.reduce((n, p) => n + p.numRatings, 0);
    v.rating = v.numRatings ? round2(v.ratingSum / v.numRatings) : 0;
  });

  // Insert everything ------------------------------------------------------
  log('Seeding: inserting documents…');
  await User.collection.insertMany(users);
  await Vendor.collection.insertMany(vendors);
  await Category.collection.insertMany(categories);
  await Product.collection.insertMany(products);
  await Review.collection.insertMany(reviews);
  await Rating.collection.insertMany(ratings);
  welcome.usedCount = redemptions.length;
  await Coupon.collection.insertMany(couponDocs);
  if (redemptions.length) await CouponRedemption.collection.insertMany(redemptions);
  await Order.collection.insertMany(orders);
  await Cart.collection.insertOne(cart);
  await Settings.collection.insertOne(settings);

  const summary = {
    customers: customers.length, vendors: vendors.length, adminsKept: keptAdmins.length, categories: categories.length,
    products: products.length, reviews: reviews.length, orders: orders.length, coupons: couponDocs.length,
  };
  log(`Seeding complete: ${JSON.stringify(summary)}`);
  return summary;
}

/* ------------------------------------------------------- CLI entry point */

const runDirectly = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (runDirectly) {
  const { connectDB } = await import('../config/db.js');
  const { initCache, cache } = await import('../services/cache.js');
  const { initSearch, reindexAll, searchEngine } = await import('../services/search.js');
  try {
    await connectDB({ retries: 30 });
    await initCache();
    await initSearch();
    await seedDatabase({ live: process.argv.includes('--live') });
    if (searchEngine() === 'elasticsearch') await reindexAll();
    await cache.delPattern('*');
    console.log(`\nVendors (password ${DEMO_ACCOUNTS.vendor.password}):`);
    STORES.forEach((s) => console.log(`  ${s.email.padEnd(28)} ${s.storeName}`));
    console.log(`\nCustomers (password ${DEMO_ACCOUNTS.customer.password}): ${CUSTOMERS.length} accounts, e.g. ${CUSTOMERS[0][1]}, ${CUSTOMERS[1][1]}`);
    console.log('\nNo admin account is seeded; existing admin accounts were kept.');
    console.log('If the API server is running with the in-memory cache, restart it to drop cached pages.');
  } catch (err) {
    console.error('Seeding failed:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    process.exit();
  }
}
