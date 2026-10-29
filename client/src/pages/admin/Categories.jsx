import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGrid, Pencil, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { cn, number } from '../../lib/format';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { Field, Switch } from '../../components/ui/Controls';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import { EmptyState, ErrorState, Skeleton, Spinner } from '../../components/ui/Feedback';

const EMPTY = { name: '', image: '', group: 'General', order: 0 };

export default function AdminCategories() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(null); // null = closed, {} = new, category = edit
  const [form, setForm] = useState(EMPTY);
  const [deleting, setDeleting] = useState(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-categories'],
    queryFn: () => api.get('/admin/categories').then((r) => r.data),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-categories'] });
    queryClient.invalidateQueries({ queryKey: ['categories'] });
  };

  const save = useMutation({
    mutationFn: (body) => (editing?._id ? api.patch(`/admin/categories/${editing._id}`, body) : api.post('/admin/categories', body)),
    onSuccess: () => {
      toast.success(editing?._id ? 'Category updated' : 'Category created');
      setEditing(null);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const toggle = useMutation({
    mutationFn: ({ id, isActive }) => api.patch(`/admin/categories/${id}`, { isActive }),
    onSuccess: (res, { isActive }) => {
      toast.success(`${isActive ? 'Shown' : 'Hidden'} — ${res.data.affectedProducts} product(s) ${isActive ? 'visible again' : 'hidden from shoppers'}`);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: (id) => api.delete(`/admin/categories/${id}`),
    onSuccess: (res) => {
      toast.success(`Category deleted — ${res.data.hiddenProducts} product(s) hidden until their sellers pick a new category`);
      setDeleting(null);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const open = (category) => {
    setEditing(category || {});
    setForm(category ? { name: category.name, image: category.image || '', group: category.group, order: category.order } : EMPTY);
  };
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const submit = () => {
    if (form.name.trim().length < 2) return toast.error('Name must be at least 2 characters');
    save.mutate({ name: form.name.trim(), image: form.image.trim() || undefined, group: form.group, order: Number(form.order) || 0 });
  };

  return (
    <div>
      <PageHeader
        title="Categories"
        description="Create, rename, reorder or hide the categories shoppers browse."
        actions={<button type="button" onClick={() => open(null)} className="btn btn-primary"><Plus className="h-4 w-4" /> Add category</button>}
      />

      <div className="card overflow-hidden">
        {error ? (
          <ErrorState error={error} onRetry={refetch} className="m-4" />
        ) : isLoading ? (
          <div className="space-y-2 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : !data.categories.length ? (
          <EmptyState icon={LayoutGrid} title="No categories yet" description="Add the first category so sellers can list products." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr><th>Category</th><th>Group</th><th className="text-right">Order</th><th className="text-right">Products</th><th className="text-center">Visible</th><th /></tr>
              </thead>
              <tbody>
                {data.categories.map((c) => (
                  <tr key={c._id} className={cn(!c.isActive && 'opacity-60')}>
                    <td>
                      <div className="flex min-w-[200px] items-center gap-3">
                        {c.image ? <img src={c.image} alt="" className="h-10 w-10 rounded-lg bg-zinc-50 object-contain p-1 dark:bg-white/5" /> : <div className="h-10 w-10 rounded-lg bg-zinc-100 dark:bg-white/5" />}
                        <p className="font-semibold">{c.name}</p>
                      </div>
                    </td>
                    <td className="text-xs">{c.group}</td>
                    <td className="text-right tabular-nums">{c.order}</td>
                    <td className="text-right tabular-nums">{number(c.productCount)}</td>
                    <td className="text-center">
                      <Switch size="sm" checked={c.isActive} disabled={toggle.isPending} onChange={(isActive) => toggle.mutate({ id: c._id, isActive })} label="Toggle visibility" />
                    </td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <button type="button" onClick={() => open(c)} className="btn-icon h-8 w-8" title="Edit"><Pencil className="h-4 w-4" /></button>
                        <button type="button" onClick={() => setDeleting(c)} className="btn-icon h-8 w-8 hover:text-rose-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?._id ? `Edit ${editing.name}` : 'New category'}
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>{save.isPending && <Spinner className="h-4 w-4" />} Save</button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" required><input value={form.name} onChange={set('name')} maxLength={50} className="input" /></Field>
          <Field label="Image URL"><input value={form.image} onChange={set('image')} placeholder="https://…" className="input" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Group">
              <select value={form.group} onChange={set('group')} className="input">
                {(data?.groups || ['General']).map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
            <Field label="Order"><input type="number" min={0} value={form.order} onChange={set('order')} className="input" /></Field>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => remove.mutate(deleting._id)}
        loading={remove.isPending}
        danger
        title={`Delete ${deleting?.name}?`}
        description={`Its ${deleting?.productCount || 0} product(s) are hidden from shoppers until their sellers move them to another category. To pause it instead, switch it off.`}
        confirmLabel="Delete category"
      />
    </div>
  );
}
