import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ChevronRight, CreditCard, PackageOpen } from 'lucide-react';
import { api } from '../lib/api';
import { formatDate, money } from '../lib/format';
import StatusBadge from '../components/ui/StatusBadge';
import Pagination from '../components/ui/Pagination';
import { Segmented } from '../components/ui/Controls';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/Feedback';

const TABS = [
  { value: '', label: 'All' },
  { value: 'placed', label: 'Placed' },
  { value: 'processing', label: 'Processing' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function Orders() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['orders', status, page],
    queryFn: () => api.get('/orders', { params: { status: status || undefined, page, limit: 8 } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="container-page py-8">
      <h1 className="font-display text-3xl font-bold tracking-tight">My orders</h1>
      <p className="mt-1 text-sm muted">Track packages, download invoices and review your purchases.</p>

      <div className="mt-6 overflow-x-auto pb-1 scrollbar-none">
        <Segmented
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          options={TABS}
        />
      </div>

      <div className="mt-6 space-y-4">
        {error ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : isLoading ? (
          Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-40" />)
        ) : !data.items.length ? (
          <EmptyState icon={PackageOpen} title="No orders here yet" description="When you place an order it will show up here." action={<Link to="/search" className="btn btn-primary">Start shopping</Link>} />
        ) : (
          data.items.map((order, i) => {
            const items = order.packages.flatMap((p) => p.items);
            return (
              <motion.div key={order._id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                <Link to={`/orders/${order._id}`} className="group card block overflow-hidden transition hover:border-brand-200 hover:shadow-lg hover:shadow-brand-900/5 dark:hover:border-brand-400/20">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-zinc-100 bg-zinc-50/60 px-5 py-3 text-xs dark:border-white/5 dark:bg-white/[0.02]">
                    <div>
                      <p className="muted">Order placed</p>
                      <p className="font-semibold">{formatDate(order.createdAt)}</p>
                    </div>
                    <div>
                      <p className="muted">Total</p>
                      <p className="font-semibold">{money(order.pricing.total)}</p>
                    </div>
                    <div>
                      <p className="muted">Packages</p>
                      <p className="font-semibold">{order.packages.length}</p>
                    </div>
                    <div className="ml-auto text-right">
                      <p className="muted">Order #</p>
                      <p className="font-mono font-semibold">{order.orderNumber}</p>
                    </div>
                  </div>
                  <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
                    <div className="flex -space-x-3">
                      {items.slice(0, 4).map((item, idx) => (
                        <img key={idx} src={item.image} alt="" className="h-16 w-16 rounded-2xl bg-white object-contain p-1 ring-2 ring-white dark:bg-zinc-800 dark:ring-surface-dark" />
                      ))}
                      {items.length > 4 && <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-100 text-sm font-bold ring-2 ring-white dark:bg-white/10 dark:ring-surface-dark">+{items.length - 4}</span>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <StatusBadge status={order.status} pulse={['placed', 'processing', 'shipped'].includes(order.status)} />
                      <p className="mt-2 line-clamp-1 text-sm font-semibold">{items.map((it) => it.title).join(', ')}</p>
                      <p className="text-xs muted">From {[...new Set(order.packages.map((p) => p.storeName))].join(', ')}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {order.status === 'pending_payment' && (
                        <span className="btn btn-accent btn-sm">
                          <CreditCard className="h-3.5 w-3.5" /> Complete payment
                        </span>
                      )}
                      <ChevronRight className="h-5 w-5 text-zinc-300 transition group-hover:translate-x-1 group-hover:text-brand-500" />
                    </div>
                  </div>
                </Link>
              </motion.div>
            );
          })
        )}
      </div>
      <Pagination className="mt-8" page={page} pages={data?.pages} onChange={setPage} />
    </div>
  );
}
