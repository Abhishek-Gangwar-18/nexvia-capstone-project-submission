import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, '../..');

dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

const bool = (value, fallback = false) =>
  value === undefined || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());

const port = Number(process.env.PORT) || 5050;

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port,
  serverUrl: (process.env.SERVER_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  clientUrls: (process.env.CLIENT_URL || 'http://localhost:5180')
    .split(',')
    .map((url) => url.trim().replace(/\/$/, ''))
    .filter(Boolean),

  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vendora',
  autoSeed: bool(process.env.AUTO_SEED, true),

  jwtSecret: process.env.JWT_SECRET || 'vendora-dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  redisUrl: process.env.REDIS_URL || '',

  elastic: {
    node: process.env.ELASTICSEARCH_NODE || '',
    apiKey: process.env.ELASTICSEARCH_API_KEY || '',
    username: process.env.ELASTICSEARCH_USERNAME || '',
    password: process.env.ELASTICSEARCH_PASSWORD || '',
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

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Vendora <no-reply@vendora.dev>',
  },
};

export const isProd = env.nodeEnv === 'production';
export const PLATFORM_NAME = 'Vendora';
