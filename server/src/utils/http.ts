import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** An error with an HTTP status; the error middleware turns it into a JSON response. */
export class ApiError extends Error {
  status: number;
  details?: Record<string, any>;

  constructor(status: number, message: string, details?: Record<string, any>) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Wraps an async route handler so rejected promises reach the error middleware (Express 4). */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const parsePagination = (query: Record<string, any>, { defaultLimit = 20, maxLimit = 100 }: Record<string, any> = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};

export const paginated = <T>(items: T[], total: number, page: number, limit: number) => ({
  items,
  total,
  page,
  limit,
  pages: Math.max(1, Math.ceil(total / limit)),
});

export const round2 = (n: number | string): number => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const escapeRegex = (text = '') => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
