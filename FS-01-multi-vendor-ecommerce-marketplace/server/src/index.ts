import { env } from './config/env.ts';
import { connectDB, supportsTransactions } from './config/db.ts';
import { initCache } from './services/cache.ts';
import { initSearch, syncIndexIfNeeded } from './services/search.ts';
import { logStorageDriver } from './services/storage.ts';
import { assertPaymentConfig, logPaymentProvider } from './services/payment.ts';
import { Product } from './models/Product.ts';
import { releaseExpiredReservations, RESERVATION_MINUTES } from './services/orders.ts';
import { releaseDuePayouts, RETURN_WINDOW_DAYS } from './services/payouts.ts';
import { runReconciliation } from './services/reconcile.ts';
import { createApp } from './app.ts';
import { syncEntityIndexes, watchEntityChanges } from './services/entitySearch.ts';
import { watchCoupons, watchProducts, watchVendors } from './services/productEvents.ts';
import { logger } from './utils/logger.ts';

async function start() {
  await connectDB();
  logger.info(
    supportsTransactions()
      ? 'MongoDB: replica set detected -> payments are finalized in multi-document transactions'
      : 'MongoDB: standalone server -> transactions unavailable, payments use atomic single-document claims',
  );
  await initCache();
  logger.info(`Auth: ${env.accessTokenTtl} access tokens, refresh cookie rotated on use (idle ${env.refreshIdleDays}d, max ${env.sessionMaxDays}d)`);
  await initSearch();
  logStorageDriver();
  assertPaymentConfig();
  logPaymentProvider();

  if (env.autoSeed && (await Product.estimatedDocumentCount()) === 0) {
    logger.info('Empty database detected -> seeding demo marketplace data (set AUTO_SEED=false to skip)');
    const { seedDatabase } = await import('./seed/seed.ts');
    await seedDatabase({ log: logger.info });
  }
  await syncIndexIfNeeded();
  await syncEntityIndexes();
  watchEntityChanges();
  watchProducts();
  watchCoupons();
  watchVendors();

  // Unpaid orders hold stock for RESERVATION_MINUTES; this returns it once the window passes.
  // Each release is an atomic claim, so running it on several instances at once is safe.
  const sweep = () => releaseExpiredReservations().catch((err) => logger.warn(`Reservation sweep failed: ${err.message}`));
  sweep();
  const sweeper = setInterval(sweep, 60 * 1000);
  logger.info(`Orders: unpaid orders hold stock for ${RESERVATION_MINUTES} min`);

  // Vendor payouts after the return window (hourly) and Stripe reconciliation (every 6 hours).
  // Both claim their work atomically, so several instances can run them at once.
  const job = (name, fn) => () => fn().catch((err) => logger.warn(`${name} failed: ${err.message}`));
  const payoutJob = job('Payout job', releaseDuePayouts);
  const reconcileJob = job('Reconciliation', runReconciliation);
  const payoutTimer = setInterval(payoutJob, 60 * 60 * 1000);
  const reconcileTimer = setInterval(reconcileJob, 6 * 60 * 60 * 1000);
  setTimeout(payoutJob, 30 * 1000).unref();
  setTimeout(reconcileJob, 2 * 60 * 1000).unref();
  logger.info(`Payouts: vendors are paid ${RETURN_WINDOW_DAYS} days after delivery (return window), checked hourly`);

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.ok(`Vendora API ready on ${env.serverUrl}  (client: ${env.clientUrls[0]})`);
  });
  // Exit instead of crashing with a stack trace; the payout and sweep timers above must not run without the API.
  server.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      logger.error(
        `Port ${env.port} is already in use: another Vendora API is still running (often an older "pnpm run dev" in another terminal). ` +
          `Stop it with Ctrl+C there, or find it with: Get-NetTCPConnection -LocalPort ${env.port} -State Listen`,
      );
    } else logger.error('Server error:', err);
    process.exit(1);
  });

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    clearInterval(sweeper);
    clearInterval(payoutTimer);
    clearInterval(reconcileTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
