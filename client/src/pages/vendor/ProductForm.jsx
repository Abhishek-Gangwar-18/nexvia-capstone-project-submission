import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, Eye, Plus, Save, Star, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { cn, discountOf, money } from '../../lib/format';
import { useCategories } from '../../lib/hooks';
import { useAuth } from '../../store/auth';
import ImageUploader from '../../components/ui/ImageUploader';
import { Field, Switch } from '../../components/ui/Controls';
import { PageLoader, Spinner } from '../../components/ui/Feedback';
import Price from '../../components/ui/Price';

const EMPTY = { title: '', description: '', brand: '', category: '', price: '', mrp: '', stock: '', sku: '', images: [], tags: [], specs: [], isActive: true };

function validate(f) {
  const e = {};
  if (f.title.trim().length < 3) e.title = 'Title must be at least 3 characters';
  if (!f.category) e.category = 'Choose a category';
  if (!(Number(f.price) > 0)) e.price = 'Enter a selling price';
  if (f.mrp && Number(f.mrp) < Number(f.price)) e.mrp = 'MRP can’t be lower than the selling price';
  if (f.stock === '' || !Number.isInteger(Number(f.stock)) || Number(f.stock) < 0) e.stock = 'Enter stock as a whole number';
  if (!f.images.length) e.images = 'Add at least one image';
  return e;
}

function Section({ title, description, children }) {
  return (
    <div className="card p-6">
      <h2 className="font-semibold">{title}</h2>
      {description && <p className="mb-5 text-xs muted">{description}</p>}
      <div className={description ? '' : 'mt-5'}>{children}</div>
    </div>
  );
}

export default function ProductForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuth((s) => s.user);
  const { data: categories = [] } = useCategories();
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);

  const existing = useQuery({
    queryKey: ['vendor-product', id],
    queryFn: () => api.get(`/vendor/products/${id}`).then((r) => r.data.product),
    enabled: editing,
  });

  useEffect(() => {
    if (existing.data) {
      const p = existing.data;
      setForm({
        title: p.title, description: p.description || '', brand: p.brand || '', category: p.category, price: p.price, mrp: p.mrp > p.price ? p.mrp : '',
        stock: p.stock, sku: p.sku || '', images: p.images.map(({ url, key }) => ({ url, key })), tags: p.tags || [], specs: p.specs || [], isActive: p.isActive,
      });
    }
  }, [existing.data]);

  if (editing && existing.isLoading) return <PageLoader />;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const addTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (tag && !form.tags.includes(tag) && form.tags.length < 15) setForm((f) => ({ ...f, tags: [...f.tags, tag] }));
    setTagInput('');
  };
  const setSpec = (i, key, value) => setForm((f) => ({ ...f, specs: f.specs.map((s, idx) => (idx === i ? { ...s, [key]: value } : s)) }));

  const submit = async (e) => {
    e.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length) {
      toast.error('Please fix the highlighted fields');
      return;
    }
    const payload = {
      ...form,
      title: form.title.trim(),
      brand: form.brand.trim() || 'Generic',
      price: Number(form.price),
      mrp: form.mrp ? Number(form.mrp) : Number(form.price),
      stock: Number(form.stock),
      images: form.images.map(({ url, key }) => (key ? { url, key } : { url })),
      specs: form.specs.filter((s) => s.label.trim() && s.value.trim()),
    };
    setSaving(true);
    try {
      if (editing) await api.patch(`/vendor/products/${id}`, payload);
      else await api.post('/vendor/products', payload);
      toast.success(editing ? 'Product updated' : 'Product published! It’s now searchable.');
      queryClient.invalidateQueries({ queryKey: ['vendor-products'] });
      queryClient.invalidateQueries({ queryKey: ['vendor-product', id] });
      navigate('/vendor/products');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const discount = discountOf({ price: Number(form.price), mrp: Number(form.mrp) });
  const preview = form.images[0]?.url;

  return (
    <form onSubmit={submit} noValidate>
      <Link to="/vendor/products" className="inline-flex items-center gap-1 text-sm font-semibold muted hover:text-brand-600">
        <ChevronLeft className="h-4 w-4" /> Products
      </Link>
      <div className="mt-2 mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">{editing ? 'Edit product' : 'Add a new product'}</h1>
        <button type="submit" disabled={saving} className="btn btn-primary">
          {saving ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />} {editing ? 'Save changes' : 'Publish product'}
        </button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Section title="Basic information" description="What shoppers see first">
            <div className="space-y-4">
              <Field label="Product title" error={errors.title} required>
                <input value={form.title} onChange={set('title')} maxLength={150} className={cn('input', errors.title && 'input-error')} placeholder="e.g. Noise-cancelling wireless earbuds" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Category" error={errors.category} required>
                  <select value={form.category} onChange={set('category')} className={cn('input', errors.category && 'input-error')}>
                    <option value="">Select a category</option>
                    {['Electronics', 'Fashion', 'Beauty', 'Home', 'Grocery', 'Sports'].map((group) => (
                      <optgroup key={group} label={group}>
                        {categories.filter((c) => c.group === group).map((c) => (
                          <option key={c._id} value={c._id}>{c.name}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </Field>
                <Field label="Brand">
                  <input value={form.brand} onChange={set('brand')} className="input" placeholder="Your brand" />
                </Field>
              </div>
              <Field label="Description">
                <textarea value={form.description} onChange={set('description')} rows={5} maxLength={5000} className="input resize-y" placeholder="Materials, features, what’s in the box…" />
              </Field>
            </div>
          </Section>

          <Section title="Images" description="Uploaded to AWS S3 (or local storage in development). Drag to reorder — the first image is the cover.">
            <ImageUploader value={form.images} onChange={(images) => setForm((f) => ({ ...f, images }))} />
            {errors.images && <p className="field-error">{errors.images}</p>}
          </Section>

          <Section title="Pricing & inventory">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Selling price (₹)" error={errors.price} required>
                <input type="number" min="1" value={form.price} onChange={set('price')} className={cn('input', errors.price && 'input-error')} />
              </Field>
              <Field label="MRP (₹)" error={errors.mrp} hint={discount > 0 ? `${discount}% off shown to shoppers` : 'Optional'}>
                <input type="number" min="0" value={form.mrp} onChange={set('mrp')} className={cn('input', errors.mrp && 'input-error')} />
              </Field>
              <Field label="Stock" error={errors.stock} required>
                <input type="number" min="0" step="1" value={form.stock} onChange={set('stock')} className={cn('input', errors.stock && 'input-error')} />
              </Field>
              <Field label="SKU">
                <input value={form.sku} onChange={set('sku')} className="input font-mono" placeholder="Optional" />
              </Field>
            </div>
            {Number(form.price) > 0 && (
              <p className="mt-4 rounded-xl bg-brand-50 px-3 py-2 text-xs text-brand-800 dark:bg-brand-500/10 dark:text-brand-200">
                You’ll receive about <span className="font-bold">{money(Number(form.price) * (1 - (user.vendor?.commissionRate ?? 10) / 100))}</span> per unit after the{' '}
                {user.vendor?.commissionRate ?? 10}% platform commission.
              </p>
            )}
          </Section>

          <Section title="Tags & specifications" description="Tags improve search; specifications appear on the product page">
            <Field label="Tags" hint="Press Enter to add">
              <div className="input flex min-h-[46px] flex-wrap items-center gap-1.5 py-1.5">
                <AnimatePresence>
                  {form.tags.map((t) => (
                    <motion.span key={t} initial={{ scale: 0.7 }} animate={{ scale: 1 }} exit={{ scale: 0.7, opacity: 0 }} className="flex items-center gap-1 rounded-lg bg-brand-100 px-2 py-1 text-xs font-semibold text-brand-700 dark:bg-brand-500/20 dark:text-brand-200">
                      #{t}
                      <button type="button" onClick={() => setForm((f) => ({ ...f, tags: f.tags.filter((x) => x !== t) }))} aria-label={`Remove ${t}`}><X className="h-3 w-3" /></button>
                    </motion.span>
                  ))}
                </AnimatePresence>
                <input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      addTag();
                    } else if (e.key === 'Backspace' && !tagInput && form.tags.length) {
                      setForm((f) => ({ ...f, tags: f.tags.slice(0, -1) }));
                    }
                  }}
                  onBlur={addTag}
                  className="min-w-[120px] flex-1 bg-transparent py-1 text-sm outline-none"
                  placeholder={form.tags.length ? '' : 'wireless, bluetooth…'}
                />
              </div>
            </Field>
            <div className="mt-5">
              <p className="label">Specifications</p>
              <div className="space-y-2">
                <AnimatePresence initial={false}>
                  {form.specs.map((s, i) => (
                    <motion.div key={i} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="flex gap-2">
                      <input value={s.label} onChange={(e) => setSpec(i, 'label', e.target.value)} placeholder="e.g. Battery" className="input w-1/3" />
                      <input value={s.value} onChange={(e) => setSpec(i, 'value', e.target.value)} placeholder="e.g. 30 hours" className="input flex-1" />
                      <button type="button" onClick={() => setForm((f) => ({ ...f, specs: f.specs.filter((_, idx) => idx !== i) }))} className="btn-icon shrink-0 hover:text-rose-600" aria-label="Remove specification"><X className="h-4 w-4" /></button>
                    </motion.div>
                  ))}
                </AnimatePresence>
                <button type="button" onClick={() => setForm((f) => ({ ...f, specs: [...f.specs, { label: '', value: '' }] }))} className="btn btn-ghost btn-sm">
                  <Plus className="h-4 w-4" /> Add specification
                </button>
              </div>
            </div>
          </Section>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
          <div className="card p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold">Visible to shoppers</p>
                <p className="text-xs muted">{form.isActive ? 'Listed in search and your store' : 'Hidden — only you can see it'}</p>
              </div>
              <Switch checked={form.isActive} onChange={(isActive) => setForm((f) => ({ ...f, isActive }))} label="Visibility" />
            </div>
          </div>
          <div className="card overflow-hidden">
            <p className="flex items-center gap-2 border-b border-zinc-100 px-5 py-3 text-xs font-semibold tracking-wide uppercase muted dark:border-white/5">
              <Eye className="h-3.5 w-3.5" /> Live preview
            </p>
            <div className="p-5">
              <div className="overflow-hidden rounded-2xl border border-zinc-100 dark:border-white/5">
                <div className="relative flex aspect-square items-center justify-center bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-white/[0.04] dark:to-white/[0.02]">
                  {preview ? <img src={preview} alt="" className="h-full w-full object-contain p-5" /> : <p className="text-xs muted">Your cover image</p>}
                  {discount >= 5 && <span className="absolute top-3 left-3 rounded-lg bg-gradient-to-r from-rose-500 to-orange-500 px-2 py-1 text-[11px] font-bold text-white">−{discount}%</span>}
                </div>
                <div className="space-y-1.5 p-4">
                  <p className="text-[11px] font-semibold tracking-wide text-brand-600 uppercase dark:text-brand-300">{user.vendor?.storeName}</p>
                  <p className="line-clamp-2 text-sm font-semibold">{form.title || 'Product title'}</p>
                  <p className="flex items-center gap-1 text-xs muted"><Star className="h-3 w-3" /> New listing</p>
                  <Price price={Number(form.price) || 0} mrp={Number(form.mrp) || 0} size="sm" />
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </form>
  );
}
