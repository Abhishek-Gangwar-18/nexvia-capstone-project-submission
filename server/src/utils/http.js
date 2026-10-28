export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Wraps an async route handler so rejected promises reach the error middleware (Express 4). */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const parsePagination = (query, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};

export const paginated = (items, total, page, limit) => ({
  items,
  total,
  page,
  limit,
  pages: Math.max(1, Math.ceil(total / limit)),
});

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const escapeRegex = (text = '') => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
