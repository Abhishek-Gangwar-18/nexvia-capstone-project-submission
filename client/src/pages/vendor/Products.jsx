import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, ExternalLink, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { cn, money, number } from '../../lib/format';
import { useCategoryName, useDebounce } from '../../lib/hooks';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { Segmented, Switch } from '../../components/ui/Controls';
import Pagination from '../../components/ui/Pagination';
import { ConfirmDialog } from '../../components/ui/Modal';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/Feedback';

const TABS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Live' },
  { value: 'inactive', label: 'Hidden' },
  { value: 'low_stock', label: 'Low stock' },
  { value: 'out_of_stock', label: 'Out of stock' },
];

function StockBadge({ stock }) {
  const tone = stock === 0 ? 'bg-rose-100 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300' : stock <= 10 ? 'bg-amber-100 text-amber-800 dark:bg-amber-400/10 dark:text-amber-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300';
  return <span className={cn('rounded-lg px-2 py-1 text-xs font-bold tabular-nums', tone)}>{stock === 0 ? 'Out' : number(stock)}</span>;
}

export default function VendorProducts() {
  const queryClient = useQueryClient();
  const categoryName = useCategoryName();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  const [deleting, setDeleting] = useState(null);
  const search = useDebounce(q, 300);

  const queryKey = ['vendor-products', status, search, sort, page];
  const { data, isLoading, error, refetch } = useQuery({
    queryKey,
    queryFn: () => api.get('/vendor/products', { params: { status: status || undefined, q: search || undefined, sort, page, limit: 10 } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  const toggle = useMutation({
    mutationFn: ({ id, isActive }) => api.patch(`/vendor/products/${id}`, { isActive }),
    onMutate: async ({ id, isActive }) => {
      queryClient.setQueryData(queryKey, (old) => old && { ...old, items: old.items.map((p) => (p._id === id ? { ...p, isActive } : p)) });
    },
    onSuccess: (_, { isActive }) => toast.success(isActive ? 'Product is live' : 'Product hidden from shoppers'),
    onError: (err) => {
      toast.error(errorMessage(err));
      refetch();
    },
  });

  const remove = useMutation({
    mutationFn: (id) => api.delete(`/vendor/products/${id}`),
    onSuccess: () => {
      toast.success('Product deleted');
      setDeleting(null);
      queryClient.invalidateQueries({ queryKey: ['vendor-products'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div>
      <PageHeader
        title="Products"
        description={data ? `${data.total} products in your catalogue` : 'Manage your catalogue'}
        actions={
          <Link to="/vendor/products/new" className="btn btn-primary">
            <Plus className="h-4 w-4" /> Add product
          </Link>
        }
      />

      <div className="card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-zinc-100 p-4 lg:flex-row lg:items-center lg:justify-between dark:border-white/5">
          <div className="overflow-x-auto scrollbar-none">
            <Segmented size="sm" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={TABS} />
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1 lg:w-64">
              <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search title, SKU, brand" className="input py-2 pl-9" />
            </div>
            <select value={sort} onChange={(e) => setSort(e.target.value)} className="input w-auto py-2">
              <option value="newest">Newest</option>
              <option value="best_selling">Best selling</option>
              <option value="stock">Lowest stock</option>
              <option value="price_asc">Price ↑</option>
              <option value="price_desc">Price ↓</option>
            </select>
          </div>
        </div>

        {error ? (
          <ErrorState error={error} onRetry={refetch} className="m-4" />
        ) : isLoading ? (
          <div className="space-y-2 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>
        ) : !data.items.length ? (
          <EmptyState icon={Boxes} title="No products found" description={q || status ? 'Try a different filter.' : 'Add your first product to start selling.'} action={<Link to="/vendor/products/new" className="btn btn-primary"><Plus className="h-4 w-4" /> Add product</Link>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr><th>Product</th><th>Category</th><th className="text-right">Price</th><th className="text-center">Stock</th><th className="text-right">Sold</th><th className="text-center">Live</th><th /></tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p._id} className={cn(!p.isActive && 'opacity-60')}>
                    <td>
                      <div className="flex min-w-[240px] items-center gap-3">
                        <img src={p.thumbnail} alt="" className="h-12 w-12 shrink-0 rounded-xl bg-zinc-50 object-contain p-1 dark:bg-white/5" />
                        <div className="min-w-0">
                          <p className="line-clamp-1 font-semibold">{p.title}</p>
                          <p className="text-xs muted">{p.brand}{p.sku ? ` · ${p.sku}` : ''}</p>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-xs">{categoryName(p.category)}</td>
                    <td className="text-right whitespace-nowrap">
                      <p className="font-semibold tabular-nums">{money(p.price)}</p>
                      {p.mrp > p.price && <p className="text-xs text-zinc-400 line-through tabular-nums">{money(p.mrp)}</p>}
                    </td>
                    <td className="text-center"><StockBadge stock={p.stock} /></td>
                    <td className="text-right tabular-nums">{number(p.sold)}</td>
                    <td className="text-center">
                      {p.moderation?.status === 'removed' ? (
                        <span className="text-xs font-semibold text-rose-600" title={p.moderation.reason}>Removed by admin</span>
                      ) : (
                        <Switch size="sm" checked={p.isActive} onChange={(isActive) => toggle.mutate({ id: p._id, isActive })} label="Toggle visibility" />
                      )}
                    </td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <Link to={`/product/${p._id}`} target="_blank" className="btn-icon h-8 w-8" title="View in store"><ExternalLink className="h-4 w-4" /></Link>
                        <Link to={`/vendor/products/${p._id}/edit`} className="btn-icon h-8 w-8" title="Edit"><Pencil className="h-4 w-4" /></Link>
                        <button type="button" onClick={() => setDeleting(p)} className="btn-icon h-8 w-8 hover:text-rose-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Pagination className="mt-6" page={page} pages={data?.pages} onChange={setPage} />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => remove.mutate(deleting._id)}
        loading={remove.isPending}
        danger
        title="Delete this product?"
        description={`“${deleting?.title}” and its reviews will be removed permanently. Past orders keep their snapshot.`}
        confirmLabel="Delete product"
      />
    </div>
  );
}
