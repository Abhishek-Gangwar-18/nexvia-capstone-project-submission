import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { env, isProd } from './config/env.ts';
import { mongoStatus } from './config/db.ts';
import { cache } from './services/cache.ts';
import { searchConfigured, searchEngine } from './services/search.ts';
import { storageDriver, UPLOAD_DIR } from './services/storage.ts';
import { paymentProvider } from './services/payment.ts';
import { stripeWebhook } from './controllers/order.controller.ts';
import authRoutes from './routes/auth.routes.ts';
import catalogRoutes from './routes/catalog.routes.ts';
import shopRoutes from './routes/shop.routes.ts';
import vendorRoutes from './routes/vendor.routes.ts';
import adminRoutes from './routes/admin.routes.ts';
import { errorHandler, notFound } from './middleware/error.ts';
import { blockedGuard } from './middleware/auth.ts';
import { asyncHandler } from './utils/http.ts';

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
        // Refuse quietly: no CORS headers, so the browser blocks the page from reading the answer.
        // (Passing an Error here would turn every such request into a 500.)
        return callback(null, false);
      },
      credentials: true,
      exposedHeaders: ['X-Session'], // read by the client to skip redundant session checks (lib/api.ts)
    }),
  );
  app.use(compression());
  if (!isProd) app.use(morgan('dev'));

  // Stripe signs the raw request body, so the webhook must be registered before the JSON parser.
  app.post('/payments/webhook', express.raw({ type: 'application/json' }), asyncHandler(stripeWebhook));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));

  // Coarse flood guard, counted per instance to spare Redis a command on every request. The limits that
  // protect accounts (login, refresh, password change) are shared through Redis in routes/auth.routes.ts.
  app.use(rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      services: {
        database: mongoStatus().connected ? 'connected' : 'disconnected',
        cache: cache.connected ? cache.driver : 'redis (reconnecting)',
        search: searchConfigured() && searchEngine() !== 'elasticsearch' ? 'mongodb (elasticsearch reconnecting)' : searchEngine(),
        storage: storageDriver(),
        payments: paymentProvider(),
      },
    });
  });

  // A browser used by a blocked account gets nothing but the "account blocked" answer.
  app.use(blockedGuard);

  // Routes sit at the root (no /api prefix): this server only serves the API; the client is deployed separately.
  app.use('/auth', authRoutes);
  app.use('/', catalogRoutes);
  app.use('/', shopRoutes);
  app.use('/vendor', vendorRoutes);
  app.use('/admin', adminRoutes);

  app.get('/', (_req, res) => res.json({ name: 'Vendora API', docs: '/health', client: env.clientUrls[0] }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
