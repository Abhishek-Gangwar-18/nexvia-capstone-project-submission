import crypto from 'node:crypto';
import slugify from 'slugify';

export const toSlug = (text) => slugify(String(text || ''), { lower: true, strict: true, trim: true }).slice(0, 80);

/** Builds a slug that is unique for the given model (appends a short random suffix on collision). */
export async function uniqueSlug(Model, text, excludeId) {
  const base = toSlug(text) || 'item';
  let candidate = base;
  for (let attempt = 0; attempt < 5; attempt++) {
    const filter = { slug: candidate };
    if (excludeId) filter._id = { $ne: excludeId };
    if (!(await Model.exists(filter))) return candidate;
    candidate = `${base}-${crypto.randomBytes(3).toString('hex')}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}
