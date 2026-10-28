import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Ticket, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { cn, formatDate, money } from '../../lib/format';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { Field, Segmented, Switch } from '../../components/ui/Controls';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import { EmptyState, ErrorState, Skeleton, Spinner } from '../../components/ui/Feedback';

const EMPTY = { code: '', description: '', type: 'percent', value: 10, minOrder: 0, maxDiscount: 0, expiresAt: '', usageLimit: 0, perUserLimit: 1, isActive: true };

function CouponForm({ initial, onSubmit, saving, onCancel }) {
  const [form, setForm] = useState(initial);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = (e) => {
    e.preventDefault();
    onSubmit({
      ...form,
      code: form.code.trim().toUpperCase(),
      value: Number(form.value),
      minOrder: Number(form.minOrder) || 0,
      maxDiscount: form.type === 'percent' ? Number(form.maxDiscount) || 0 : 0,
      usageLimit: Number(form.usageLimit) || 0,
      perUserLimit: Number(form.perUserLimit) || 1,
      expiresAt: form.expiresAt ? new Date(`${form.expiresAt}T23:59:59`).toISOString() : null,
    });
  };
  const preview =
    form.type === 'percent'
      ? `${form.value || 0}% off${Number(form.maxDiscount) ? ` up to ${money(form.maxDiscount)}` : ''}`
      : `${money(form.value || 0)} off`;

  return (
    <form id="coupon-form" onSubmit={submit} className="space-y-4">
      <div className="flex items-center gap-3 rounded-2xl border-2 border-dashed border-brand-300 bg-brand-50/50 p-4 dark:border-brand-400/30 dark:bg-brand-500/5">
        <Ticket className="h-6 w-6 text-brand-600" />
        <div>
          <p className="font-mono text-lg font-bold">{form.code || 'CODE'}</p>
          <p className="text-xs muted">{preview}{Number(form.minOrder) ? ` on orders above ${money(form.minOrder)}` : ''}</p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Code" required hint="3–20 letters, numbers, - or _">
          <input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') }))} maxLength={20} className="input font-mono uppercase" required />
        </Field>
        <Field label="Discount type">
          <Segmented className="w-full [&>button]:flex-1" value={form.type} onChange={(type) => setForm((f) => ({ ...f, type }))} options={[{ value: 'percent', label: 'Percentage' }, { value: 'flat', label: 'Flat ₹' }]} />
        </Field>
      </div>
      <Field label="Description">
        <input value={form.description} onChange={set('description')} maxLength={160} className="input" placeholder="Shown to shoppers, e.g. 15% off skincare" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={form.type === 'percent' ? 'Percent off' : 'Amount off (₹)'} required>
          <input type="number" min="1" max={form.type === 'percent' ? 90 : undefined} value={form.value} onChange={set('value')} className="input" required />
        </Field>
        <Field label="Min. order (₹)">
          <input type="number" min="0" value={form.minOrder} onChange={set('minOrder')} className="input" />
        </Field>
        {form.type === 'percent' && (
          <Field label="Max discount (₹)" hint="0 = no cap">
            <input type="number" min="0" value={form.maxDiscount} onChange={set('maxDiscount')} className="input" />
          </Field>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Expires on">
          <input type="date" value={form.expiresAt} onChange={set('expiresAt')} className="input" />
        </Field>
        <Field label="Total uses" hint="0 = unlimited">
          <input type="number" min="0" value={form.usageLimit} onChange={set('usageLimit')} className="input" />
        </Field>
        <Field label="Uses per customer">
          <input type="number" min="1" value={form.perUserLimit} onChange={set('perUserLimit')} className="input" />
        </Field>
      </div>
      <label className="flex items-center justify-between rounded-xl bg-zinc-50 px-4 py-3 text-sm dark:bg-white/[0.03]">
        Active
        <Switch checked={form.isActive} onChange={(isActive) => setForm((f) => ({ ...f, isActive }))} label="Active" />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-ghost">Cancel</button>
        <button type="submit" disabled={saving} className="btn btn-primary">{saving && <Spinner className="h-4 w-4" />} Save coupon</button>
      </div>
    </form>
  );
}

/** Coupon CRUD used by both sellers (store coupons) and admins (platform-wide coupons). */
export default function CouponManager({ scope }) {
  const base = scope === 'admin' ? '/admin/coupons' : '/vendor/coupons';
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['coupons-admin', scope],
    queryFn: () => api.get(base, { params: { limit: 100, scope: scope === 'admin' ? 'all' : undefined } }).then((r) => r.data),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['coupons-admin', scope] });
    queryClient.invalidateQueries({ queryKey: ['coupons'] });
  };
  const save = useMutation({
    mutationFn: (payload) => (editing?._id ? api.put(`${base}/${editing._id}`, payload) : api.post(base, payload)),
    onSuccess: () => {
      toast.success('Coupon saved');
      setEditing(null);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const toggle = useMutation({
    mutationFn: ({ id, isActive }) => api.put(`${base}/${id}`, { isActive }),
    onSuccess: invalidate,
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id) => api.delete(`${base}/${id}`),
    onSuccess: () => {
      toast.success('Coupon deleted');
      setDeleting(null);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const now = Date.now();
  return (
    <div>
      <PageHeader
        title="Coupons"
        description={scope === 'admin' ? 'Platform-wide coupons apply to the whole cart. Store coupons created by sellers are listed too.' : 'Store coupons only discount your own products.'}
        actions={<button type="button" onClick={() => setEditing(EMPTY)} className="btn btn-primary"><Plus className="h-4 w-4" /> New coupon</button>}
      />
      {error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-44" />)}</div>
      ) : !data.items.length ? (
        <EmptyState icon={Ticket} title="No coupons yet" description="Create a coupon to reward customers and boost conversion." action={<button type="button" onClick={() => setEditing(EMPTY)} className="btn btn-primary"><Plus className="h-4 w-4" /> New coupon</button>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.items.map((c) => {
            const expired = c.expiresAt && new Date(c.expiresAt).getTime() < now;
            const exhausted = c.usageLimit && c.usedCount >= c.usageLimit;
            return (
              <div key={c._id} className={cn('card relative overflow-hidden p-5', (!c.isActive || expired) && 'opacity-70')}>
                <div className="absolute top-1/2 -left-3 h-6 w-6 -translate-y-1/2 rounded-full bg-canvas dark:bg-canvas-dark" />
                <div className="absolute top-1/2 -right-3 h-6 w-6 -translate-y-1/2 rounded-full bg-canvas dark:bg-canvas-dark" />
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-lg font-bold">{c.code}</p>
                    <p className="text-sm font-semibold text-brand-600 dark:text-brand-300">
                      {c.type === 'percent' ? `${c.value}% off` : `${money(c.value)} off`}
                      {c.maxDiscount ? ` · up to ${money(c.maxDiscount)}` : ''}
                    </p>
                  </div>
                  <Switch size="sm" checked={c.isActive} onChange={(isActive) => toggle.mutate({ id: c._id, isActive })} label="Active" />
                </div>
                <p className="mt-2 line-clamp-2 min-h-[2.5rem] text-xs muted">{c.description || '—'}</p>
                <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] font-semibold">
                  {c.vendor && scope === 'admin' && <span className="rounded-md bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300">{c.vendor.storeName}</span>}
                  {c.minOrder > 0 && <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 dark:bg-white/10">Min {money(c.minOrder)}</span>}
                  <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 dark:bg-white/10">Used {c.usedCount}{c.usageLimit ? `/${c.usageLimit}` : ''}</span>
                  {c.expiresAt && <span className={cn('rounded-md px-1.5 py-0.5', expired ? 'bg-rose-100 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300' : 'bg-zinc-100 dark:bg-white/10')}>{expired ? 'Expired' : `Till ${formatDate(c.expiresAt)}`}</span>}
                  {exhausted && <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-amber-800">Limit reached</span>}
                </div>
                <div className="mt-4 flex justify-end gap-1 border-t border-dashed border-zinc-200 pt-3 dark:border-white/10">
                  <button
                    type="button"
                    onClick={() => setEditing({ ...EMPTY, ...c, expiresAt: c.expiresAt ? c.expiresAt.slice(0, 10) : '' })}
                    className="btn btn-ghost btn-sm"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button type="button" onClick={() => setDeleting(c)} className="btn btn-ghost btn-sm text-rose-600">
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?._id ? 'Edit coupon' : 'New coupon'} size="lg">
        {editing && (
          <CouponForm
            key={editing._id || 'new'}
            initial={editing}
            saving={save.isPending}
            onCancel={() => setEditing(null)}
            onSubmit={({ _id, vendor, usedCount, usedBy, createdAt, updatedAt, __v, ...payload }) => save.mutate(payload)}
          />
        )}
      </Modal>
      <ConfirmDialog open={Boolean(deleting)} onClose={() => setDeleting(null)} onConfirm={() => remove.mutate(deleting._id)} loading={remove.isPending} danger title={`Delete ${deleting?.code}?`} description="Customers will no longer be able to use this code." confirmLabel="Delete coupon" />
    </div>
  );
}
