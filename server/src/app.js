import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { env, isProd } from './config/env.js';
import { mongoStatus } from './config/db.js';
import { cache } from './services/cache.js';
import { searchEngine } from './services/search.js';
import { storageDriver, UPLOAD_DIR } from './services/storage.js';
import { paymentProvider } from './services/payment.js';
import { razorpayWebhook } from './controllers/order.controller.js';
import authRoutes from './routes/auth.routes.js';
import catalogRoutes from './routes/catalog.routes.js';
import shopRoutes from './routes/shop.routes.js';
import vendorRoutes from './routes/vendor.routes.js';
import adminRoutes from './routes/admin.routes.js';
import { errorHandler, notFound } from './middleware/error.js';
import { asyncHandler } from './utils/http.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow same-origin/tools (no Origin header), configured client URLs, and any localhost port in development.
        if (!origin || env.clientUrls.includes(origin) || (!isProd && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))) {
          return callback(null, true);
        }
        return callback(new Error(`Origin ${origin} is not allowed by CORS`));
      },
      credentials: true,
    }),
  );
  app.use(compression());
  if (!isProd) app.use(morgan('dev'));

  // Razorpay signs the raw request body, so the webhook must be registered before the JSON parser.
  app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), asyncHandler(razorpayWebhook));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));

  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false }));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      services: {
        database: mongoStatus().connected ? 'connected' : 'disconnected',
        cache: cache.driver,
        search: searchEngine(),
        storage: storageDriver(),
        payments: paymentProvider(),
      },
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api', catalogRoutes);
  app.use('/api', shopRoutes);
  app.use('/api/vendor', vendorRoutes);
  app.use('/api/admin', adminRoutes);

  app.get('/', (_req, res) => res.json({ name: 'Vendora API', docs: '/api/health', client: env.clientUrls[0] }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
