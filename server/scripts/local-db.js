/**
 * Zero-install MongoDB for local development.
 *
 * Starts a real `mongod` (downloaded once by mongodb-memory-server) on the host/port from MONGO_URI,
 * storing data in server/.data/db so it survives restarts. Does nothing when MONGO_URI points to an
 * external database (e.g. MongoDB Atlas) or when something is already listening on that port.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { MongoMemoryServer } from 'mongodb-memory-server';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vendora';
const log = (msg) => console.log(`[db] ${msg}`);

const portInUse = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

async function main() {
  const url = new URL(uri.replace(/^mongodb(\+srv)?:/, 'http:'));
  if (uri.startsWith('mongodb+srv:') || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    log('MONGO_URI points to an external database -> embedded MongoDB not needed.');
    return;
  }
  const port = Number(url.port) || 27017;
  if (await portInUse(port)) {
    log(`Port ${port} is already in use -> assuming a MongoDB server is running there.`);
    return;
  }

  const dbPath = path.join(root, '.data', 'db');
  fs.mkdirSync(dbPath, { recursive: true });
  log('Starting embedded MongoDB (the first run downloads the MongoDB binary, this can take a minute)…');
  const server = await MongoMemoryServer.create({
    instance: { port, ip: '127.0.0.1', dbPath, storageEngine: 'wiredTiger' },
  });
  log(`Embedded MongoDB ready at ${server.getUri()} (data persisted in server/.data/db)`);

  const stop = async () => {
    await server.stop({ doCleanup: false, force: false });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('[db] Failed to start embedded MongoDB:', err);
  process.exit(1);
});
