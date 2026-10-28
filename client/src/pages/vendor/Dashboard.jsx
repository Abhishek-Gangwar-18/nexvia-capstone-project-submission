import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { AlertTriangle, ArrowRight, Boxes, ExternalLink, IndianRupee, Lock, Plus, ShoppingCart, Unlock, Wallet } from 'lucide-react';
import { api } from '../../lib/api';
import { compactMoney, formatDate, money, number } from '../../lib/format';
import { useAuth } from '../../store/auth';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { BarList, StatCard, TrendChart } from '../../components/dashboard/Charts';
import StatusBadge from '../../components/ui/StatusBadge';
import { ErrorState, Skeleton } from '../../components/ui/Feedback';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

export default function VendorDashboard() {
  const user = useAuth((s) => s.user);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['vendor-dashboard'], queryFn: () => api.get('/vendor/dashboard').then((r) => r.data) });

  if (error) return <ErrorState error={error} onRetry={refetch} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${greeting()}, ${user.name.split(' ')[0]} 👋`}
        description="Here’s how your store performed over the last 30 days."
        actions={
          <>
            <Link to={`/store/${user.vendor?._id}`} className="btn btn-secondary">
              <ExternalLink className="h-4 w-4" /> View store
            </Link>
            <Link to="/vendor/products/new" className="btn btn-primary">
              <Plus className="h-4 w-4" /> Add product
            </Link>
          </>
        }
      />

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-36" />)}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard index={0} label="Revenue (30d)" icon={IndianRupee} value={data.kpis.revenue.value} change={data.kpis.revenue.change} format={compactMoney} hint="vs previous 30 days" />
          <StatCard index={1} label="Your earnings (30d)" icon={Wallet} value={data.kpis.earnings.value} change={data.kpis.earnings.change} format={compactMoney} hint="after commission" />
          <StatCard index={2} label="Orders (30d)" icon={ShoppingCart} value={data.kpis.orders.value} change={data.kpis.orders.change} hint="packages" />
          <StatCard index={3} label="Products" icon={Boxes} value={data.kpis.products.value} hint={`${data.kpis.products.outOfStock} out of stock`} />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        {isLoading ? (
          <Skeleton className="h-[420px]" />
        ) : (
          <TrendChart
            title="Sales performance"
            subtitle="Daily totals, last 30 days"
            data={data.series}
            metrics={[
              { key: 'revenue', label: 'Revenue', format: money },
              { key: 'earnings', label: 'Earnings', format: money },
              { key: 'orders', label: 'Orders', format: number, kind: 'count' },
            ]}
          />
        )}

        <div className="card flex flex-col p-5">
          <p className="font-semibold">Payouts</p>
          <p className="text-xs muted">Split automatically on every order</p>
          {isLoading ? (
            <Skeleton className="mt-4 h-40" />
          ) : (
            <div className="mt-4 space-y-3">
              <div className="flex items-center gap-3 rounded-2xl bg-amber-50 p-4 dark:bg-amber-400/[0.07]">
                <Lock className="h-5 w-5 text-amber-600" />
                <div className="flex-1">
                  <p className="text-xs text-amber-800 dark:text-amber-300">On hold · until delivery</p>
                  <p className="font-display text-xl font-bold">{money(data.payouts.onHold)}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-2xl bg-emerald-50 p-4 dark:bg-emerald-400/[0.07]">
                <Unlock className="h-5 w-5 text-emerald-600" />
                <div className="flex-1">
                  <p className="text-xs text-emerald-800 dark:text-emerald-300">Released to you</p>
                  <p className="font-display text-xl font-bold">{money(data.payouts.released)}</p>
                </div>
              </div>
              <div className="rounded-2xl border border-zinc-100 p-4 text-xs dark:border-white/5">
                <p className="muted">Lifetime: {money(data.lifetime.revenue)} sales · {money(data.lifetime.commission)} platform commission</p>
              </div>
            </div>
          )}
          <Link to="/vendor/payouts" className="mt-auto flex items-center gap-1 pt-4 text-sm font-semibold text-brand-600 dark:text-brand-300">
            View ledger <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card p-5">
          <p className="font-semibold">Top products</p>
          <p className="mb-4 text-xs muted">By lifetime revenue</p>
          {isLoading ? <Skeleton className="h-48" /> : <BarList items={data.topProducts.map((p) => ({ label: p.title, value: p.revenue }))} format={money} />}
        </div>

        <div className="card overflow-hidden">
          <div className="flex items-center justify-between p-5 pb-3">
            <div>
              <p className="font-semibold">Recent orders</p>
              <p className="text-xs muted">Latest packages to fulfil</p>
            </div>
            <Link to="/vendor/orders" className="text-sm font-semibold text-brand-600 dark:text-brand-300">All orders →</Link>
          </div>
          {isLoading ? (
            <Skeleton className="m-5 h-48" />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr><th>Order</th><th>Customer</th><th>Status</th><th className="text-right">Total</th></tr>
                </thead>
                <tbody>
                  {data.recentOrders.map((o) => (
                    <tr key={o._id}>
                      <td>
                        <p className="font-mono text-xs font-semibold">{o.orderNumber}</p>
                        <p className="text-[11px] muted">{formatDate(o.createdAt)}</p>
                      </td>
                      <td className="whitespace-nowrap">{o.customer}</td>
                      <td><StatusBadge status={o.status} /></td>
                      <td className="text-right font-semibold tabular-nums">{money(o.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {data?.lowStock?.length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="card p-5">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 text-amber-500" /> Low stock alerts
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.lowStock.map((p) => (
              <Link key={p._id} to={`/vendor/products/${p._id}/edit`} className="flex items-center gap-3 rounded-2xl border border-zinc-100 p-3 transition hover:border-amber-300 dark:border-white/5">
                <img src={p.thumbnail} alt="" className="h-12 w-12 rounded-xl bg-zinc-50 object-contain p-1 dark:bg-white/5" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{p.title}</p>
                  <p className="text-xs font-semibold text-amber-600">Only {p.stock} left · restock</p>
                </div>
              </Link>
            ))}
          </div>
        </motion.div>
      )}
    </div>
  );
}
