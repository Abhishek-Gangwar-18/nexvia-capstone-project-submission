import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, '../..');

dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

const bool = (value, fallback = false) =>
  value === undefined || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());

const nodeEnv = process.env.NODE_ENV || 'development';
const deployed = Boolean(
  process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.VERCEL || process.env.FLY_APP_NAME ||
  process.env.DYNO || process.env.K_SERVICE || process.env.AWS_EXECUTION_ENV || process.env.DEPLOYMENT_ENV,
);
if (deployed && nodeEnv !== 'production') {
  throw new Error('NODE_ENV=production is required in deployed environments');
}

const jwtSecret = process.env.JWT_SECRET || (nodeEnv === 'development' ? 'vendora-dev-secret-change-me' : '');
if (nodeEnv === 'production') {
  const knownDevelopmentSecrets = new Set(['vendora-dev-secret-change-me', 'secret', 'development', 'changeme']);
  const frequencies = [...jwtSecret].reduce((counts, char) => counts.set(char, (counts.get(char) || 0) + 1), new Map());
  const entropy = [...frequencies.values()].reduce((sum, count) => {
    const probability = count / jwtSecret.length;
    return sum - probability * Math.log2(probability);
  }, 0);
  const placeholder = /(?:replace-with|change[-_ ]?me|your[-_ ]|example|sample)/i.test(jwtSecret);
  if (Buffer.byteLength(jwtSecret, 'utf8') < 32 || knownDevelopmentSecrets.has(jwtSecret.toLowerCase()) || frequencies.size < 16 || entropy < 3.5 || placeholder) {
    throw new Error('Production requires a high-entropy JWT_SECRET of at least 32 bytes; the development fallback is not allowed');
  }
}

const elasticNode = process.env.ELASTICSEARCH_NODE || '';
const elasticApiKey = process.env.ELASTICSEARCH_API_KEY || '';
const elasticUsername = process.env.ELASTICSEARCH_USERNAME || '';
const elasticPassword = process.env.ELASTICSEARCH_PASSWORD || '';
if (nodeEnv === 'production' && elasticNode) {
  let protocol;
  try {
    protocol = new URL(elasticNode).protocol;
  } catch {
    throw new Error('ELASTICSEARCH_NODE must be a valid HTTPS URL in production');
  }
  if (protocol !== 'https:') throw new Error('ELASTICSEARCH_NODE must use HTTPS in production');
  if (!elasticApiKey && !(elasticUsername && elasticPassword)) {
    throw new Error('Production Elasticsearch requires ELASTICSEARCH_API_KEY or both ELASTICSEARCH_USERNAME and ELASTICSEARCH_PASSWORD');
  }
}

const autoSeed = bool(process.env.AUTO_SEED, nodeEnv !== 'production');
if (nodeEnv === 'production' && autoSeed) {
  throw new Error('AUTO_SEED=true is not allowed in production; demo accounts and destructive seeding are development-only');
}

const port = Number(process.env.PORT) || 5050;

export const env = {
  nodeEnv,
  port,
  serverUrl: (process.env.SERVER_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  clientUrls: (process.env.CLIENT_URL || 'http://localhost:5180')
    .split(',')
    .map((url) => url.trim().replace(/\/$/, ''))
    .filter(Boolean),

  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vendora',
  autoSeed,

  jwtSecret,
  /** Short-lived access token (JWT, sent as a Bearer header, kept in memory by the client). */
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '15m',
  /** Refresh token (httpOnly cookie): a session stays alive while used at least every N days, up to the max. */
  refreshIdleDays: Number(process.env.REFRESH_IDLE_DAYS) || 30,
  sessionMaxDays: Number(process.env.SESSION_MAX_DAYS) || 90,
  /** 'lax' when the client is served from the same site (Vite proxy); 'none' (+ Secure) for a cross-site API domain. */
  cookieSameSite: process.env.COOKIE_SAMESITE || (process.env.NODE_ENV === 'production' ? 'none' : 'lax'),

  redisUrl: process.env.REDIS_URL || '',
  /** Production refuses to start without Redis unless this is set (single-instance demo deployments). */
  allowMemoryCache: bool(process.env.ALLOW_MEMORY_CACHE, false),

  elastic: {
    node: elasticNode,
    apiKey: elasticApiKey,
    username: elasticUsername,
    password: elasticPassword,
    index: process.env.ELASTICSEARCH_INDEX || 'vendora-products',
  },

  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    bucket: process.env.AWS_S3_BUCKET || '',
    endpoint: process.env.AWS_S3_ENDPOINT || '',
    publicUrl: (process.env.AWS_S3_PUBLIC_URL || '').replace(/\/$/, ''),
    forcePathStyle: bool(process.env.AWS_S3_FORCE_PATH_STYLE, false),
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    /** Signing secret of a separate Connect webhook endpoint (events from vendor accounts), if you create one. */
    connectWebhookSecret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '',
    /** Charge currency (ISO code, lowercase). Prices in the catalogue are in this currency. */
    currency: (process.env.STRIPE_CURRENCY || 'inr').toLowerCase(),
    /** Country for new vendor Express accounts; empty = the platform account's country. */
    connectCountry: (process.env.STRIPE_CONNECT_COUNTRY || '').toUpperCase(),
    /** The built-in test gateway marks orders paid without money; production refuses it unless this is set. */
    allowTestGateway: bool(process.env.ALLOW_TEST_GATEWAY, false),
  },

  payments: {
    /** Days after delivery a customer can request a return; the vendor is paid only after this window. */
    returnWindowDays: Number(process.env.RETURN_WINDOW_DAYS) || 7,
  },
};

export const isProd = env.nodeEnv === 'production';
export const PLATFORM_NAME = 'Vendora';
