import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Boxes, IndianRupee, Percent, Receipt, ShoppingCart, Store, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { cn, compactMoney, formatDate, money, number } from '../../lib/format';
import { STATUS } from '../../lib/status';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { BarList, StatCard, TrendChart } from '../../components/dashboard/Charts';
import { Segmented } from '../../components/ui/Controls';
import StatusBadge from '../../components/ui/StatusBadge';
import { StoreAvatar } from '../../components/ui/Brand';
import { ErrorState, Skeleton } from '../../components/ui/Feedback';

const RANGES = [
  { value: 7, label: '7D' },
  { value: 30, label: '30D' },
  { value: 90, label: '90D' },
  { value: 365, label: '1Y' },
];
const STATUS_ORDER = ['placed', 'packed', 'shipped', 'delivered', 'cancelled'];

export default function Analytics() {
  const [range, setRange] = useState(30);
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['admin-analytics', range],
    queryFn: () => api.get('/admin/analytics', { params: { range } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const k = data?.kpis;
  const statusTotal = data?.byStatus.reduce((s, x) => s + x.count, 0) || 1;
  const label = RANGES.find((r) => r.value === range).label;

  return (
    <div className={cn('space-y-6 transition-opacity', isFetching && !isLoading && 'opacity-70')}>
      <PageHeader title="Marketplace analytics" description="GMV, commission revenue and fulfilment across all sellers." actions={<Segmented value={range} onChange={setRange} options={RANGES} />} />

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-36" />)}</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard index={0} label={`GMV (${label})`} icon={IndianRupee} value={k.gmv.value} change={k.gmv.change} format={compactMoney} hint="vs previous period" />
          <StatCard index={1} label={`Commission revenue (${label})`} icon={Percent} value={k.commission.value} change={k.commission.change} format={compactMoney} hint="platform earnings" />
          <StatCard index={2} label={`Orders (${label})`} icon={ShoppingCart} value={k.orders.value} change={k.orders.change} hint="paid orders" />
          <StatCard index={3} label="Avg. order value" icon={Receipt} value={k.aov.value} change={k.aov.change} format={(n) => money(Math.round(n))} />
          <StatCard index={4} label="Customers" icon={Users} value={k.customers.value} hint={`+${k.customers.new} new in ${label}`} />
          <StatCard index={5} label="Live sellers" icon={Store} value={k.vendors.value} hint={k.vendors.pending ? `${k.vendors.pending} awaiting approval` : 'none pending'} />
          <StatCard index={6} label="Active products" icon={Boxes} value={k.products.value} hint="across all stores" />
          <Link to="/admin/vendors?status=pending" className={cn('card flex flex-col justify-center gap-1 p-5 transition hover:border-amber-300', k.vendors.pending ? 'bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-400/10 dark:to-orange-400/5' : '')}>
            <p className="text-sm font-medium muted">Seller applications</p>
            <p className="font-display text-3xl font-bold">{k.vendors.pending}</p>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">{k.vendors.pending ? 'Review now →' : 'All caught up'}</p>
          </Link>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        {isLoading ? (
          <Skeleton className="h-[420px]" />
        ) : (
          <TrendChart
            key={range}
            title="Revenue trend"
            subtitle={range > 90 ? 'Monthly totals' : 'Daily totals'}
            data={data.series}
            metrics={[
              { key: 'gmv', label: 'GMV', format: money },
              { key: 'commission', label: 'Commission', format: money },
              { key: 'orders', label: 'Orders', format: number, kind: 'count' },
            ]}
          />
        )}
        <div className="card p-5">
          <p className="font-semibold">Package fulfilment</p>
          <p className="mb-4 text-xs muted">Status of packages in this period</p>
          {isLoading ? (
            <Skeleton className="h-60" />
          ) : (
            <ul className="space-y-3">
              {STATUS_ORDER.map((s) => {
                const count = data.byStatus.find((x) => x.status === s)?.count || 0;
                return (
                  <li key={s}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <StatusBadge status={s} />
                      <span className="font-semibold tabular-nums">
                        {number(count)} <span className="text-xs font-normal muted">({((count / statusTotal) * 100).toFixed(0)}%)</span>
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-white/[0.06]">
                      <div className="h-full rounded-full bg-zinc-400 transition-all duration-700 dark:bg-zinc-500" style={{ width: `${(count / statusTotal) * 100}%` }} title={`${STATUS[s].label}: ${count}`} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card p-5">
          <p className="font-semibold">Sales by category</p>
          <p className="mb-4 text-xs muted">Revenue from delivered and in-progress packages</p>
          {isLoading ? <Skeleton className="h-64" /> : <BarList items={data.byCategory.map((c) => ({ label: c.name, value: c.revenue }))} format={compactMoney} />}
        </div>
        <div className="card overflow-hidden">
          <div className="p-5 pb-2">
            <p className="font-semibold">Top sellers</p>
            <p className="text-xs muted">By GMV in this period</p>
          </div>
          {isLoading ? (
            <Skeleton className="m-5 h-56" />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr><th>Store</th><th className="text-right">Orders</th><th className="text-right">GMV</th><th className="text-right">Commission</th></tr>
                </thead>
                <tbody>
                  {data.topVendors.map((v) => (
                    <tr key={v._id}>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <StoreAvatar store={v} size="h-8 w-8" rounded="rounded-lg" className="text-[10px]" />
                          <span className="font-semibold whitespace-nowrap">{v.storeName}</span>
                        </div>
                      </td>
                      <td className="text-right tabular-nums">{v.orders}</td>
                      <td className="text-right tabular-nums">{compactMoney(v.gmv)}</td>
                      <td className="text-right font-semibold tabular-nums">{compactMoney(v.commission)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card p-5">
          <p className="mb-4 font-semibold">Best-selling products</p>
          {isLoading ? (
            <Skeleton className="h-56" />
          ) : (
            <ul className="space-y-3">
              {data.topProducts.map((p, i) => (
                <li key={p._id} className="flex items-center gap-3">
                  <span className="w-5 text-center text-sm font-bold text-zinc-400">{i + 1}</span>
                  <img src={p.image} alt="" className="h-11 w-11 rounded-xl bg-zinc-50 object-contain p-1 dark:bg-white/5" />
                  <div className="min-w-0 flex-1">
                    <Link to={`/product/${p._id}`} className="block truncate text-sm font-semibold hover:text-brand-600">{p.title}</Link>
                    <p className="text-xs muted">{p.store} · {p.units} units</p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">{compactMoney(p.revenue)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between p-5 pb-2">
            <p className="font-semibold">Recent orders</p>
            <Link to="/admin/orders" className="text-sm font-semibold text-brand-600 dark:text-brand-300">All orders →</Link>
          </div>
          {isLoading ? (
            <Skeleton className="m-5 h-56" />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <tbody>
                  {data.recentOrders.map((o) => (
                    <tr key={o._id}>
                      <td>
                        <Link to={`/admin/orders/${o._id}`} className="font-mono text-xs font-semibold hover:text-brand-600">{o.orderNumber}</Link>
                        <p className="text-[11px] muted">{formatDate(o.createdAt)}</p>
                      </td>
                      <td className="text-xs">{o.customer?.name}</td>
                      <td><StatusBadge status={o.status} /></td>
                      <td className="text-right font-semibold tabular-nums">{money(o.pricing.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
