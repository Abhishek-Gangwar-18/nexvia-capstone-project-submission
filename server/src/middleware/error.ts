import multer from 'multer';
import mongoose from 'mongoose';
import { isProd } from '../config/env.ts';
import { setBlockedCookie } from '../utils/cookies.ts';
import { logger } from '../utils/logger.ts';

export const notFound = (req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
};

// eslint-disable-next-line no-unused-vars
/** MongoDB can't be reached (network drop, Atlas failover): a short 503, not a 500 with a stack trace. */
const DB_UNREACHABLE = ['MongoServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoTopologyClosedError', 'MongoNotConnectedError'];
const isDbUnreachable = (err) => DB_UNREACHABLE.includes(err?.name) || DB_UNREACHABLE.includes(err?.cause?.name);

export const errorHandler = (err, req, res, _next) => {
  if (isDbUnreachable(err)) {
    logger.warn(`${req.method} ${req.originalUrl} -> database unreachable (${err.cause?.message || err.message})`);
    res.set('Retry-After', '5');
    return res.status(503).json({ message: 'The service is temporarily unavailable. Please try again in a moment.', details: { code: 'DB_UNAVAILABLE' } });
  }

  let status = err.status || err.statusCode || 500;
  let message = err.message || 'Something went wrong';
  let details = err.details;

  if (err instanceof mongoose.Error.CastError) {
    status = 400;
    message = `Invalid ${err.path}`;
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = 400;
    message = Object.values(err.errors)[0]?.message || 'Validation failed';
  } else if (err.code === 11000) {
    status = 409;
    const field = Object.keys(err.keyValue || {})[0] || 'value';
    message = `That ${field} is already in use`;
  } else if (err instanceof multer.MulterError) {
    status = 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 5 MB or smaller' : err.message;
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Malformed JSON body';
  }

  // A blocked account (services/session.ts accountBlocked): keep this browser closed to the whole site.
  if (err.blockedUserId) setBlockedCookie(res, err.blockedUserId);

  if (status >= 500) logger.error(`${req.method} ${req.originalUrl} ->`, err);

  res.status(status).json({
    message: status >= 500 && isProd ? 'Internal server error' : message,
    ...(details ? { details } : {}),
    ...(!isProd && status >= 500 ? { stack: err.stack } : {}),
  });
};
