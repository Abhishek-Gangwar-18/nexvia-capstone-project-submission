import { env } from './config/env.js';
import { connectDB, supportsTransactions } from './config/db.js';
import { initCache } from './services/cache.js';
import { restoreRevokedSessions } from './services/session.js';
import { initSearch, syncIndexIfNeeded } from './services/search.js';
import { logStorageDriver } from './services/storage.js';
import { logPaymentProvider } from './services/payment.js';
import { Product } from './models/Product.js';
import { createApp } from './app.js';
import { logger } from './utils/logger.js';

async function start() {
  await connectDB();
  logger.info(
    supportsTransactions()
      ? 'MongoDB: replica set detected -> payments are finalized in multi-document transactions'
      : 'MongoDB: standalone server -> transactions unavailable, payments use atomic single-document claims',
  );
  await initCache();
  const restored = await restoreRevokedSessions();
  if (restored) logger.info(`Sessions: restored ${restored} revoked session(s) from MongoDB`);
  await initSearch();
  logStorageDriver();
  logPaymentProvider();

  if (env.autoSeed && (await Product.estimatedDocumentCount()) === 0) {
    logger.info('Empty database detected -> seeding demo marketplace data (set AUTO_SEED=false to skip)');
    const { seedDatabase } = await import('./seed/seed.js');
    await seedDatabase({ log: logger.info });
  }
  await syncIndexIfNeeded();

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.ok(`Vendora API ready on ${env.serverUrl}  (client: ${env.clientUrls[0]})`);
  });

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
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
