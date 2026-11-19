/**
 * Load test for the read endpoints: latency (p50/p95/p99), throughput and errors at several concurrency
 * levels. Run it against a LOCAL or throwaway stack only, never production or Atlas.
 *
 *   API_URL=http://localhost:15050 node scripts/load-test.ts [--levels 1,10,50,100] [--requests 300] [--only search,cart]
 *
 * The API limits each client address to 600 requests a minute. To measure the server instead of the limiter,
 * every request carries its own X-Forwarded-For address: point API_URL straight at the API (one proxy hop at
 * most), as the app trusts exactly one hop.
 */
const API = (process.env.API_URL || 'http://localhost:15050').replace(/\/$/, '');
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const LEVELS = arg('levels', '1,10,50,100').split(',').map(Number);
const REQUESTS = Number(arg('requests', '300'));
const ONLY = arg('only', '').split(',').filter(Boolean);

let ip = 0;
const nextIp = () => { ip += 1; return `10.${(ip >> 16) & 255}.${(ip >> 8) & 255}.${ip & 255}`; };

async function get(path: string, token?: string) {
  const started = performance.now();
  const res = await fetch(API + path, {
    headers: { Accept: 'application/json', 'X-Forwarded-For': nextIp(), ...(token && { Authorization: `Bearer ${token}` }) },
  });
  await res.arrayBuffer();
  return { ms: performance.now() - started, status: res.status };
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function run(path: string, concurrency: number, total: number, token?: string) {
  for (let i = 0; i < 5; i++) await get(path, token); // warm-up
  const times: number[] = [];
  let errors = 0;
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < total) {
      next += 1;
      try {
        const r = await get(path, token);
        times.push(r.ms);
        if (r.status >= 400) errors += 1;
      } catch {
        errors += 1;
      }
    }
  }));
  const seconds = (performance.now() - started) / 1000;
  times.sort((a, b) => a - b);
  return { p50: pct(times, 50), p95: pct(times, 95), p99: pct(times, 99), rps: total / seconds, errors };
}

const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Forwarded-For': nextIp() },
  body: JSON.stringify({ email: 'customer@vendora.dev', password: 'Customer@123' }),
}).then((r) => r.json());
const token = login.accessToken;
const product = (await fetch(`${API}/products?limit=1`, { headers: { Accept: 'application/json' } }).then((r) => r.json())).items[0]._id;
const order = (await fetch(`${API}/orders?status=delivered&limit=1`, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }).then((r) => r.json())).items?.[0]?._id;

const ENDPOINTS: [string, string, boolean?][] = [
  ['health', '/health'],
  ['home', '/home'],
  ['list', '/products?limit=24'],
  ['filters', '/products?minPrice=500&maxPrice=50000&rating=4&sort=price_asc&limit=24'],
  ['search', '/products?q=phone&limit=24'],
  ['typo', '/products?q=iphnoe&limit=24'],
  ['suggest', '/products/suggest?q=lap'],
  ['product', `/products/${product}`],
  ['stores', '/stores?q=tech'],
  ['cart', '/cart', true],
  ['orders', '/orders?limit=10', true],
  ...(order ? [['invoice', `/orders/${order}/invoice`, true] as [string, string, boolean]] : []),
];

const health = await fetch(`${API}/health`).then((r) => r.json());
console.log(`API ${API} | cache: ${health.services.cache} | search: ${health.services.search} | ${REQUESTS} requests per endpoint and level`);
console.log('endpoint'.padEnd(10), 'users'.padStart(5), 'p50 ms'.padStart(8), 'p95 ms'.padStart(8), 'p99 ms'.padStart(8), 'req/s'.padStart(8), 'errors'.padStart(7));
for (const [name, path, auth] of ENDPOINTS) {
  if (ONLY.length && !ONLY.includes(name)) continue;
  for (const level of LEVELS) {
    const total = name === 'invoice' ? Math.min(REQUESTS, 150) : REQUESTS;
    const r = await run(path, level, total, auth ? token : undefined);
    console.log(name.padEnd(10), String(level).padStart(5), r.p50.toFixed(1).padStart(8), r.p95.toFixed(1).padStart(8), r.p99.toFixed(1).padStart(8), r.rps.toFixed(0).padStart(8), String(r.errors).padStart(7));
  }
}
