import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronRight, Search } from 'lucide-react';
import { api } from '../../lib/api';
import { formatDateTime, money } from '../../lib/format';
import { useDebounce } from '../../lib/hooks';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { Segmented } from '../../components/ui/Controls';
import StatusBadge from '../../components/ui/StatusBadge';
import Pagination from '../../components/ui/Pagination';
import { ErrorState, Skeleton } from '../../components/ui/Feedback';

export default function AdminOrders() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounce(q, 300);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-orders', status, search, page],
    queryFn: () => api.get('/admin/orders', { params: { status: status || undefined, q: search || undefined, page } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const counts = data?.counts || {};

  return (
    <div>
      <PageHeader title="Orders" description="Every order across the marketplace. Open one to manage its packages." />
      <div className="card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-zinc-100 p-4 xl:flex-row xl:items-center xl:justify-between dark:border-white/5">
          <div className="overflow-x-auto scrollbar-none">
            <Segmented
              size="sm"
              value={status}
              onChange={(v) => { setStatus(v); setPage(1); }}
              options={[
                { value: '', label: 'All' },
                { value: 'placed', label: 'Placed', count: counts.placed || 0 },
                { value: 'processing', label: 'Processing', count: counts.processing || 0 },
                { value: 'shipped', label: 'Shipped', count: counts.shipped || 0 },
                { value: 'delivered', label: 'Delivered' },
                { value: 'pending_payment', label: 'Unpaid' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
            />
          </div>
          <div className="relative xl:w-64">
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Order number" className="input py-2 pl-9" />
          </div>
        </div>
        {error ? (
          <ErrorState error={error} onRetry={refetch} className="m-4" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr><th>Order</th><th>Customer</th><th>Sellers</th><th>Status</th><th>Payment</th><th className="text-right">Total</th><th className="text-right">Commission</th><th /></tr>
              </thead>
              <tbody>
                {isLoading
                  ? Array.from({ length: 10 }, (_, i) => <tr key={i}><td colSpan={8}><Skeleton className="h-8" /></td></tr>)
                  : data.items.map((o) => (
                      <tr key={o._id} onClick={() => navigate(`/admin/orders/${o._id}`)} className="cursor-pointer">
                        <td>
                          <p className="font-mono text-xs font-semibold">{o.orderNumber}</p>
                          <p className="text-[11px] whitespace-nowrap muted">{formatDateTime(o.createdAt)}</p>
                        </td>
                        <td>
                          <p className="text-sm font-medium whitespace-nowrap">{o.customer?.name}</p>
                          <p className="text-[11px] muted">{o.customer?.email}</p>
                        </td>
                        <td className="max-w-[200px] truncate text-xs">{o.packages.map((p) => p.storeName).join(', ')}</td>
                        <td><StatusBadge status={o.status} /></td>
                        <td><StatusBadge status={o.payment.status} /></td>
                        <td className="text-right font-semibold tabular-nums">{money(o.pricing.total)}</td>
                        <td className="text-right text-brand-600 tabular-nums dark:text-brand-300">{money(o.packages.reduce((s, p) => s + (p.status === 'cancelled' ? 0 : p.commission), 0))}</td>
                        <td><ChevronRight className="h-4 w-4 text-zinc-300" /></td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Pagination className="mt-6" page={page} pages={data?.pages} onChange={setPage} />
    </div>
  );
}
