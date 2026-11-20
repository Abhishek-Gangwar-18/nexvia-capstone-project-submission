import mongoose from 'mongoose';
import { z } from 'zod';
import { Category, CATEGORY_GROUPS, CATEGORY_NAME_COLLATION } from '../models/Category.ts';
import { Product } from '../models/Product.ts';
import { invalidateCatalog } from '../services/catalog.ts';
import { indexProducts, resetCategoryNames } from '../services/search.ts';
import { cache } from '../services/cache.ts';
import { ApiError } from '../utils/http.ts';

const fields = {
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(50),
  image: z.string().trim().url('Image must be a URL').max(500).optional(),
  group: z.enum(CATEGORY_GROUPS as [string, ...string[]]).optional(),
  order: z.coerce.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
};
export const categoryCreateSchema = z.object(fields);
export const categoryUpdateSchema = z.object(fields).partial().refine((b) => Object.keys(b).length, 'Nothing to update');

async function assertNameFree(name: string, exceptId?: unknown) {
  const taken = await Category.findOne({ name, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).collation(CATEGORY_NAME_COLLATION).lean();
  if (taken) throw new ApiError(409, `A category named "${taken.name}" already exists`);
}

async function findCategory(id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid category id');
  const category = await Category.findById(id);
  if (!category) throw new ApiError(404, 'Category not found');
  return category;
}

/** Shows or hides every product of a category for shoppers, then refreshes caches and the search index. */
async function setProductsHidden(categoryId, hidden) {
  const ids = await Product.find({ category: categoryId }).distinct('_id');
  if (ids.length) {
    await Product.updateMany({ _id: { $in: ids } }, { $set: { categoryHidden: hidden } });
    await cache.del(...ids.map((id) => `product:${id}`));
    indexProducts(ids);
  }
  return ids.length;
}

async function afterCategoryChange() {
  resetCategoryNames();
  await invalidateCatalog();
}

/** All categories (hidden ones included) with their product counts. */
export async function listCategories(req, res) {
  const [categories, counts] = await Promise.all([
    Category.find().sort({ order: 1, name: 1 }).lean(),
    Product.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: '$category', count: { $sum: 1 } } }]),
  ]);
  const byCategory = new Map(counts.map((c) => [String(c._id), c.count]));
  res.json({ categories: categories.map((c) => ({ ...c, productCount: byCategory.get(String(c._id)) || 0 })), groups: CATEGORY_GROUPS });
}

export async function createCategory(req, res) {
  await assertNameFree(req.body.name);
  const category = await Category.create(req.body);
  await afterCategoryChange();
  res.status(201).json({ category });
}

/** Rename, regroup, reorder, change the image, or hide/show (hiding hides all its products). */
export async function updateCategory(req, res) {
  const category = await findCategory(req.params.id);
  if (req.body.name) await assertNameFree(req.body.name, category._id);
  const visibilityChanged = req.body.isActive !== undefined && req.body.isActive !== category.isActive;
  const renamed = req.body.name !== undefined && req.body.name !== category.name;
  Object.assign(category, req.body);
  await category.save();
  // Search documents carry the category name, so the name cache is reset before re-indexing.
  resetCategoryNames();
  const affected = visibilityChanged ? await setProductsHidden(category._id, !category.isActive) : 0;
  if (renamed && !visibilityChanged) indexProducts(await Product.find({ category: category._id }).distinct('_id'));
  await afterCategoryChange();
  res.json({ category, affectedProducts: affected });
}

/** Deletes the category; its products stay in the database but are hidden until the seller picks a new category. */
export async function deleteCategory(req, res) {
  const category = await findCategory(req.params.id);
  await category.deleteOne();
  const affected = await setProductsHidden(category._id, true);
  await afterCategoryChange();
  res.json({ deleted: true, hiddenProducts: affected });
}
