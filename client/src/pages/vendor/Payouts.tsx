import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Lock, Percent, Undo2, Unlock, Wallet } from 'lucide-react';
import { api } from '../../lib/api';
import { formatDate, money } from '../../lib/format';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { Segmented } from '../../components/ui/Controls';
import StatusBadge from '../../components/ui/StatusBadge';
import Pagination from '../../components/ui/Pagination';
import { ErrorState, Skeleton } from '../../components/ui/Feedback';
import StripeConnectCard from '../../components/dashboard/StripeConnectCard';

export default function Payouts() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['vendor-payouts', status, page],
    queryFn: () => api.get('/vendor/payouts', { params: { status: status || undefined, page, limit: 12 } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const s: Record<string, any> = data?.summary || {};
  const commission = Object.values(s).reduce((sum: number, x: any) => sum + (x.commission || 0), 0) - (s.reversed?.commission || 0);
  const cards = [
    { label: 'On hold', sub: `Paid ${data?.returnWindowDays ?? 7} days after delivery`, value: s.on_hold?.amount || 0, icon: Lock, tone: 'text-amber-600 bg-amber-50 dark:bg-amber-400/10' },
    { label: 'Released', sub: 'Paid out to you', value: s.released?.amount || 0, icon: Unlock, tone: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-400/10' },
    { label: 'Reversed', sub: 'Cancelled packages', value: s.reversed?.amount || 0, icon: Undo2, tone: 'text-rose-600 bg-rose-50 dark:bg-rose-400/10' },
    { label: 'Commission paid', sub: 'Platform fee to Vendora', value: commission, icon: Percent, tone: 'text-brand-600 bg-brand-50 dark:bg-brand-500/10' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Payouts" description={`Every payment is split automatically: your earning is paid out once the ${data?.returnWindowDays ?? 7}-day return window after delivery has passed.`} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ label, sub, value, icon: Icon, tone }) => (
          <div key={label} className="card p-5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium muted">{label}</p>
              <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${tone}`}><Icon className="h-4 w-4" /></span>
            </div>
            {isLoading ? <Skeleton className="mt-2 h-8 w-32" /> : <p className="mt-1 font-display text-2xl font-bold">{money(value)}</p>}
            <p className="text-xs muted">{sub}</p>
          </div>
        ))}
      </div>

      <StripeConnectCard />

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 p-4 dark:border-white/5">
          <p className="flex items-center gap-2 font-semibold"><Wallet className="h-4 w-4 text-brand-600" /> Ledger</p>
          <Segmented
            size="sm"
            value={status}
            onChange={(v) => { setStatus(v); setPage(1); }}
            options={[
              { value: '', label: 'All' },
              { value: 'on_hold', label: 'On hold' },
              { value: 'released', label: 'Released' },
              { value: 'reversed', label: 'Reversed' },
            ]}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr><th>Order</th><th>Package</th><th className="text-right">Sale</th><th className="text-right">Commission</th><th className="text-right">Your earning</th><th>Payout</th><th>Mode</th></tr>
            </thead>
            <tbody>
              {isLoading
                ? Array.from({ length: 6 }, (_, i) => (
                    <tr key={i}><td colSpan={7}><Skeleton className="h-6" /></td></tr>
                  ))
                : data.items.map((row) => (
                    <tr key={`${row._id}-${row.orderNumber}`}>
                      <td>
                        <p className="font-mono text-xs font-semibold">{row.orderNumber}</p>
                        <p className="text-[11px] muted">{formatDate(row.createdAt)}</p>
                      </td>
                      <td><StatusBadge status={row.packageStatus} /></td>
                      <td className="text-right tabular-nums">{money(row.total)}</td>
                      <td className="text-right text-rose-600 tabular-nums">−{money(row.commission)} <span className="text-[10px] muted">({row.commissionRate}%)</span></td>
                      <td className="text-right font-semibold tabular-nums">{money(row.vendorEarning)}</td>
                      <td>
                        <StatusBadge status={row.payout?.status} />
                        {row.payout?.releasedAt && <p className="mt-0.5 text-[10px] muted">{formatDate(row.payout.releasedAt)}{row.payout.amount != null && row.payout.amount !== row.vendorEarning ? ` · ${money(row.payout.amount)} after returns` : ''}</p>}
                        {row.payout?.status === 'on_hold' && row.payout.releaseAfter && <p className="mt-0.5 text-[10px] muted">from {formatDate(row.payout.releaseAfter)}</p>}
                        {row.payout?.status === 'on_hold' && row.payout.error && <p className="mt-0.5 max-w-[200px] text-[10px] text-amber-600">{row.payout.error}</p>}
                      </td>
                      <td className="text-xs">{row.payout?.status !== 'released' ? '—' : row.payout.mode === 'stripe' ? 'Stripe transfer' : 'Manual settlement'}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination page={page} pages={data?.pages} onChange={setPage} />
    </div>
  );
}
