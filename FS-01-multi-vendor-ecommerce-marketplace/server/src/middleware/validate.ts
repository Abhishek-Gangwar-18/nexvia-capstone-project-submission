import { ApiError } from '../utils/http.ts';

/** Validates req.body / req.query with a zod schema; parsed (coerced) data replaces the body or lands on req.valid. */
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source] ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join('.');
    const fields = Object.fromEntries(result.error.issues.map((i) => [i.path.join('.') || '_', i.message]));
    return next(new ApiError(400, field ? `${field}: ${issue.message}` : issue.message, { fields }));
  }
  if (source === 'body') req.body = result.data;
  else req.valid = result.data;
  return next();
};
