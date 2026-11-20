import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { cn, money, number } from '../../lib/format';
import { useCategories, useCategoryName, useDebounce } from '../../lib/hooks';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { Segmented, Switch } from '../../components/ui/Controls';
import Pagination from '../../components/ui/Pagination';
import { ErrorState, Skeleton } from '../../components/ui/Feedback';
import { ReasonDialog } from '../../components/ui/Modal';

export default function AdminProducts() {
  const queryClient = useQueryClient();
  const { data: categories = [] } = useCategories();
  const categoryName = useCategoryName();
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [removing, setRemoving] = useState(null);
  const search = useDebounce(q, 300);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-products', status, category, search, page],
    queryFn: () => api.get('/admin/products', { params: { status: status || undefined, category: category || undefined, q: search || undefined, page } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  const moderate = useMutation({
    mutationFn: ({ id, status, reason }: Record<string, any>) => api.patch(`/admin/products/${id}`, { status, reason }),
    onSuccess: (_, { status }) => {
      toast.success(status === 'approved' ? 'Product restored' : 'Product removed from the marketplace');
      queryClient.invalidateQueries({ queryKey: ['admin-products'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div>
      <PageHeader title="Products" description={data ? `${number(data.total)} products across all stores` : 'Moderate the catalogue'} />
      <div className="card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-zinc-100 p-4 lg:flex-row lg:items-center lg:justify-between dark:border-white/5">
          <Segmented size="sm" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[{ value: '', label: 'All' }, { value: 'active', label: 'Live' }, { value: 'inactive', label: 'Hidden' }, { value: 'deleted', label: 'Deleted' }]} />
          <div className="flex gap-2">
            <select aria-label="Filter by category" value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} className="input w-auto py-2">
              <option value="">All categories</option>
              {categories.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
            </select>
            <div className="relative lg:w-64">
              <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search products" className="input py-2 pl-9" />
            </div>
          </div>
        </div>
        {error ? (
          <ErrorState error={error} onRetry={refetch} className="m-4" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr><th>Product</th><th>Store</th><th>Category</th><th className="text-right">Price</th><th className="text-right">Stock</th><th className="text-right">Rating</th><th className="text-right">Sold</th><th className="text-center">Live</th></tr>
              </thead>
              <tbody>
                {isLoading
                  ? Array.from({ length: 10 }, (_, i) => <tr key={i}><td colSpan={8}><Skeleton className="h-10" /></td></tr>)
                  : data.items.map((p) => (
                      <tr key={p._id} className={cn((!p.isActive || p.deletedAt || p.moderation?.status === 'removed') && 'opacity-60')}>
                        <td>
                          <div className="flex min-w-[220px] items-center gap-3">
                            <img src={p.thumbnail} alt="" className="h-10 w-10 rounded-lg bg-zinc-50 object-contain p-0.5 dark:bg-white/5" />
                            <Link to={`/product/${p._id}`} target="_blank" className="line-clamp-1 font-semibold hover:text-brand-600">
                              {p.title} <ExternalLink className="inline h-3 w-3 text-zinc-400" />
                            </Link>
                            {p.deletedAt && (
                              <span title={`Deleted by the seller on ${new Date(p.deletedAt).toLocaleDateString('en-IN')}`} className="shrink-0 rounded-md bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-400/10 dark:text-rose-300">
                                Deleted by seller
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="text-xs whitespace-nowrap">{p.vendor?.storeName}</td>
                        <td className="text-xs whitespace-nowrap">{categoryName(p.category)}</td>
                        <td className="text-right tabular-nums">{money(p.price)}</td>
                        <td className={cn('text-right tabular-nums', p.stock === 0 && 'font-semibold text-rose-600')}>{p.stock}</td>
                        <td className="text-right tabular-nums">{p.rating.toFixed(1)} <span className="text-[10px] muted">({p.numRatings})</span></td>
                        <td className="text-right tabular-nums">{number(p.sold)}</td>
                        <td className="text-center" title={p.moderation?.reason || (p.isActive ? undefined : 'Hidden by the seller')}>
                          <Switch
                            size="sm"
                            checked={p.moderation?.status !== 'removed'}
                            onChange={(keep) => {
                              if (keep) return moderate.mutate({ id: p._id, status: 'approved' });
                              setRemoving(p);
                            }}
                            label="Allowed on marketplace"
                          />
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Pagination className="mt-6" page={page} pages={data?.pages} onChange={setPage} />
      <ReasonDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={(reason) => moderate.mutate({ id: removing._id, status: 'removed', reason }, { onSuccess: () => setRemoving(null) })}
        loading={moderate.isPending}
        danger
        title="Remove this product?"
        description={removing ? `"${removing.title}" will be hidden from the marketplace. The seller sees your reason.` : undefined}
        placeholder="Why are you removing this product?"
        confirmLabel="Remove product"
      />
    </div>
  );
}
