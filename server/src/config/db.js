import dns from 'node:dns';
import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/http.js';

const redact = (uri) => uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
const isLocal = (uri) => /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri);

/**
 * Atlas "mongodb+srv://" URIs need DNS SRV/TXT lookups. On some Windows setups Node's resolver only knows
 * 127.0.0.1 and those lookups are refused even though the OS resolves them fine. If the SRV lookup fails,
 * switch Node's resolver (used only for SRV/TXT, not for normal host lookups) to public DNS servers.
 */
async function ensureSrvResolvable(uri) {
  if (!uri.startsWith('mongodb+srv://')) return;
  let host;
  try {
    host = new URL(uri.replace(/^mongodb\+srv:/, 'http:')).hostname;
  } catch {
    return;
  }
  try {
    await dns.promises.resolveSrv(`_mongodb._tcp.${host}`);
  } catch (err) {
    const fallback = (process.env.DNS_SERVERS || '8.8.8.8,1.1.1.1').split(',').map((s) => s.trim()).filter(Boolean);
    logger.warn(`DNS SRV lookup via ${dns.getServers().join(', ')} failed (${err.code}) -> resolving MongoDB SRV records via ${fallback.join(', ')}`);
    dns.setServers(fallback);
    dns.promises.setServers(fallback);
  }
}

function connectionHint(err) {
  const msg = err.message || '';
  if (/whitelist|not authorized to access|IP that isn't|ReplicaSetNoPrimary|Server selection timed out/i.test(msg) && !isLocal(env.mongoUri)) {
    return ' -> Check MongoDB Atlas > Network Access: your current IP must be on the access list (or allow 0.0.0.0/0 for development).';
  }
  if (/bad auth|authentication failed/i.test(msg)) return ' -> Check the database username/password in MONGO_URI (Atlas > Database Access).';
  if (/querySrv|ENOTFOUND/i.test(msg)) return ' -> DNS lookup for the cluster failed; check the cluster host name or set DNS_SERVERS.';
  return '';
}

/**
 * Connects to MongoDB. The local embedded database may still be starting (its first run downloads a binary),
 * so local URIs are retried for a long time; a remote cluster (Atlas) fails fast with a helpful hint.
 */
export async function connectDB({ retries = isLocal(env.mongoUri) ? 120 : 6 } = {}) {
  mongoose.set('strictQuery', true);
  await ensureSrvResolvable(env.mongoUri);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(env.mongoUri, {
        serverSelectionTimeoutMS: isLocal(env.mongoUri) ? 3000 : 15000,
        maxPoolSize: 20,
      });
      logger.ok(`MongoDB connected -> ${redact(env.mongoUri)}`);
      return mongoose.connection;
    } catch (err) {
      if (attempt === retries) {
        err.message += connectionHint(err);
        throw err;
      }
      if (attempt === 1 || attempt % 5 === 0 || !isLocal(env.mongoUri)) {
        logger.warn(`Waiting for MongoDB at ${redact(env.mongoUri)} (attempt ${attempt}/${retries}) - ${err.message}${connectionHint(err)}`);
      }
      await sleep(2000);
    }
  }
  return null;
}

/** True when the server supports multi-document transactions (replica sets such as Atlas; not a standalone mongod). */
export const supportsTransactions = () => {
  const description = mongoose.connection.getClient()?.topology?.description;
  return Boolean(description && ['ReplicaSetWithPrimary', 'Sharded', 'LoadBalanced'].includes(description.type));
};

/**
 * Runs `work(session)` inside a MongoDB transaction when the deployment supports it (Atlas),
 * otherwise runs it directly (standalone dev database). `work` must do only database writes;
 * the driver may retry it on transient errors.
 */
export async function withTransaction(work) {
  if (!supportsTransactions()) return work(undefined);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export const mongoStatus = () => ({
  connected: mongoose.connection.readyState === 1,
  host: mongoose.connection.host,
  database: mongoose.connection.name,
  transactions: supportsTransactions(),
});
