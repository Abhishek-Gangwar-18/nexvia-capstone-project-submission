import type * as React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, Download, Search, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, downloadFile, errorMessage } from '../../lib/api';
import { cn, formatDateTime, money, number } from '../../lib/format';
import { useDebounce } from '../../lib/hooks';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { Segmented } from '../../components/ui/Controls';
import StatusBadge from '../../components/ui/StatusBadge';
import Pagination from '../../components/ui/Pagination';
import { ErrorState, Skeleton, Spinner } from '../../components/ui/Feedback';

const EXCEPTION_LABELS = {
  refund_failed: 'Refund failed',
  payout_reversal_failed: 'Payout not reversed',
  payment_mismatch: 'Payment mismatch',
  stock_issue: 'Stock reservation',
  delayed_dispatch: 'Delayed dispatch',
  delayed_delivery: 'Delayed delivery',
  missing_tracking: 'Missing tracking',
};
const REFUND_LABELS = { none: '—', processed: 'Refunded', pending: 'Refund pending', failed: 'Refund failed' };
const RANGES = [
  { value: 'today', label: 'Today' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
];
const EMPTY = { status: '', payment: '', fulfilment: '', refund: '', attention: '', delayed: '', minTotal: '', maxTotal: '', sort: 'newest' };

interface KpiProps {
  label?: React.ReactNode;
  value?: any;
  hint?: React.ReactNode;
  tone?: any;
  onClick?: any;
}

function Kpi({ label, value, hint, tone, onClick }: KpiProps) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick} className={cn('card p-4 text-left transition', onClick && 'hover:ring-2 hover:ring-brand-500/30')}>
      <p className="text-xs muted">{label}</p>
      <p className={cn('mt-1 font-display text-xl font-bold tabular-nums', tone)}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] muted">{hint}</p>}
    </button>
  );
}

interface KpisProps {
  range?: any;
  from?: any;
  to?: string;
  onPick?: any;
}

function Kpis({ range, from, to, onPick }: KpisProps) {
  const custom = range === 'custom';
  const { data: s, isLoading } = useQuery({
    queryKey: ['admin-orders-summary', range, from, to],
    queryFn: () => api.get('/admin/orders/summary', { params: custom ? { from: from || undefined, to: to || undefined } : { range } }).then((r) => r.data),
    enabled: !custom || Boolean(from || to),
    placeholderData: keepPreviousData,
  });
  if (isLoading || !s) return <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-20" />)}</div>;
  const hours = s.avgFulfilmentHours;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Total orders" value={number(s.orders.total)} hint={`${number(s.packages.total)} vendor packages`} onClick={() => onPick({})} />
        <Kpi label="Sales (gross / net)" value={money(s.sales.gross)} hint={`Net ${money(s.sales.net)} · AOV ${money(s.sales.aov)}`} />
        <Kpi label="Awaiting fulfilment" value={number(s.packages.awaiting)} hint="Packages placed or packed" onClick={() => onPick({ fulfilment: 'placed' })} />
        <Kpi label="In transit" value={number(s.packages.inTransit)} hint="Packages shipped" onClick={() => onPick({ fulfilment: 'shipped' })} />
        <Kpi label="Delivered" value={number(s.packages.delivered)} hint={hours != null ? `Avg ${hours < 48 ? `${Math.round(hours)}h` : `${(hours / 24).toFixed(1)} days`} to deliver` : 'Packages delivered'} onClick={() => onPick({ fulfilment: 'delivered' })} />
        <Kpi label="Cancelled orders" value={number(s.orders.cancelled)} hint={`${s.cancellationRate}% cancellation rate`} onClick={() => onPick({ status: 'cancelled' })} />
        <Kpi label="Refunds" value={money(s.refunds.amount)} hint={`${s.refunds.count} refunded · ${s.refunds.failedCount} failed (${money(s.refunds.failedAmount)})`} tone={s.refunds.failedCount ? 'text-rose-600' : ''} onClick={() => onPick({ refund: s.refunds.failedCount ? 'failed' : 'any' })} />
        <Kpi label="Needs attention" value={number(s.exceptions.total)} hint={`${s.delayed.dispatch + s.delayed.delivery} delayed · ${s.payments.pending} unpaid · ${s.payments.failed} payment failed`} tone={s.exceptions.total ? 'text-amber-600' : ''} onClick={() => onPick({ attention: 'all' })} />
      </div>
      {s.vendorPerformance.length > 0 && (
        <details className="card group">
          <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-semibold">
            Vendor fulfilment performance <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
          </summary>
          <div className="overflow-x-auto border-t border-zinc-100 dark:border-white/5">
            <table className="table-base">
              <thead><tr><th>Store</th><th className="text-right">Packages</th><th className="text-right">Open</th><th className="text-right">Delivered</th><th className="text-right">Cancelled</th><th className="text-right">Sales</th></tr></thead>
              <tbody>
                {s.vendorPerformance.map((v) => (
                  <tr key={v.vendor}>
                    <td><button type="button" onClick={() => onPick({ vendor: v.vendor, vendorName: v.storeName })} className="font-medium hover:text-brand-600">{v.storeName}</button></td>
                    <td className="text-right tabular-nums">{v.packages}</td>
                    <td className="text-right tabular-nums">{v.open}</td>
                    <td className="text-right tabular-nums">{v.delivered} <span className="text-[11px] muted">({v.fulfilmentRate}%)</span></td>
                    <td className="text-right tabular-nums">{v.cancelled} <span className="text-[11px] muted">({v.cancellationRate}%)</span></td>
                    <td className="text-right tabular-nums">{money(v.sales)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

interface ItemCellProps {
  items?: any;
}

function ItemCell({ items }: ItemCellProps) {
  const [open, setOpen] = useState(false);
  if (items.lines.length === 1) return <p className="max-w-[200px] truncate text-sm">{items.lines[0].title}{items.count > 1 && <span className="muted"> × {items.count}</span>}</p>;
  return (
    <div className="text-sm">
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(!open); }} className="flex items-center gap-1 font-medium">
        {items.count} items <ChevronDown className={cn('h-3.5 w-3.5 transition', open && 'rotate-180')} />
      </button>
      {open && <ul className="mt-1 space-y-0.5 text-xs muted">{items.lines.map((l, i) => <li key={i} className="max-w-[220px] truncate">{l.quantity} × {l.title}</li>)}</ul>}
    </div>
  );
}

const Select = ({ value, onChange, children, label }) => (
  <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="input w-auto py-2 text-sm">{children}</select>
);

export default function AdminOrders() {
  const [f, setF] = useState(EMPTY);
  const [vendor, setVendor] = useState(null);
  const [range, setRange] = useState('30');
  const [dates, setDates] = useState({ from: '', to: '' });
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const search = useDebounce(q, 300);
  const amounts = useDebounce(`${f.minTotal}|${f.maxTotal}`, 400);

  const set = (patch) => { setF((prev) => ({ ...prev, ...patch })); setPage(1); };
  const custom = range === 'custom';
  const [minTotal, maxTotal] = amounts.split('|');
  const params = Object.fromEntries(
    Object.entries({
      ...f,
      minTotal,
      maxTotal,
      q: search.trim(),
      vendor: vendor?.id,
      ...(custom ? dates : { range }),
    }).filter(([, v]) => v),
  );
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-orders', params, page],
    queryFn: () => api.get('/admin/orders', { params: { ...params, page } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  const pick = ({ vendor: id, vendorName, ...patch }: Record<string, any>) => {
    setF({ ...EMPTY, ...patch });
    setVendor(id ? { id, name: vendorName } : null);
    setPage(1);
  };
  const clearAll = () => { pick({}); setQ(''); setRange('30'); setDates({ from: '', to: '' }); };
  const active = Object.entries(f).some(([k, v]) => v && v !== EMPTY[k]) || vendor || q || range !== '30';

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadFile(`/admin/orders/export?${new URLSearchParams(params)}`, `orders-${new Date().toISOString().slice(0, 10)}.csv`);
      if (data?.total > 5000) toast(`Exported the first 5,000 of ${number(data.total)} orders. Narrow the filters for the rest.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Orders"
        description="Order operations across the marketplace. Open an order to manage its packages."
        actions={
          <button type="button" onClick={exportCsv} disabled={exporting} className="btn btn-secondary">
            {exporting ? <Spinner className="h-4 w-4" /> : <Download className="h-4 w-4" />} Export CSV
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented size="sm" value={range} onChange={(v) => { setRange(v); setPage(1); }} options={RANGES} />
        {custom && (
          <>
            <input type="date" aria-label="From" value={dates.from} max={dates.to || undefined} onChange={(e) => { setDates({ ...dates, from: e.target.value }); setPage(1); }} className="input w-auto py-1.5 text-sm" />
            <span className="muted">–</span>
            <input type="date" aria-label="To" value={dates.to} min={dates.from || undefined} onChange={(e) => { setDates({ ...dates, to: e.target.value }); setPage(1); }} className="input w-auto py-1.5 text-sm" />
          </>
        )}
      </div>

      <Kpis range={range} from={dates.from} to={dates.to} onPick={pick} />

      <div className="card mt-6 overflow-hidden">
        <div className="space-y-3 border-b border-zinc-100 p-4 dark:border-white/5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative flex-1">
              <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search order, customer, vendor, product, payment / tracking / refund ID…" className="input py-2 pl-9" />
            </div>
            <button type="button" onClick={() => set({ attention: f.attention ? '' : 'all' })} className={cn('btn btn-sm', f.attention ? 'btn-primary' : 'btn-secondary')}>
              <AlertTriangle className="h-4 w-4" /> Needs attention{data?.counts?.attention ? ` (${data.counts.attention})` : ''}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select label="Order status" value={f.status} onChange={(v) => set({ status: v })}>
              <option value="">All statuses</option>
              {['placed', 'processing', 'shipped', 'delivered', 'cancelled', 'payment_failed'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </Select>
            <Select label="Payment" value={f.payment} onChange={(v) => set({ payment: v })}>
              <option value="">All payments</option>
              {['paid', 'pending', 'failed', 'refunded'].map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
            <Select label="Fulfilment" value={f.fulfilment} onChange={(v) => set({ fulfilment: v })}>
              <option value="">Any package status</option>
              {['placed', 'packed', 'shipped', 'delivered', 'cancelled'].map((s) => <option key={s} value={s}>Package {s}</option>)}
            </Select>
            <Select label="Refund" value={f.refund} onChange={(v) => set({ refund: v })}>
              <option value="">All refunds</option>
              <option value="any">Has a refund</option>
              <option value="processed">Refunded</option>
              <option value="pending">Refund pending</option>
              <option value="failed">Refund failed</option>
              <option value="none">No refund</option>
            </Select>
            {f.attention && (
              <Select label="Exception" value={f.attention} onChange={(v) => set({ attention: v })}>
                <option value="all">Any exception</option>
                {Object.entries(EXCEPTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            )}
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={f.delayed === 'true'} onChange={(e) => set({ delayed: e.target.checked ? 'true' : '' })} /> Delayed / overdue
            </label>
            <input type="number" min="0" placeholder="Min ₹" value={f.minTotal} onChange={(e) => set({ minTotal: e.target.value })} className="input w-24 py-2 text-sm" />
            <input type="number" min="0" placeholder="Max ₹" value={f.maxTotal} onChange={(e) => set({ maxTotal: e.target.value })} className="input w-24 py-2 text-sm" />
            <Select label="Sort" value={f.sort} onChange={(v) => set({ sort: v })}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="total_desc">Highest total</option>
              <option value="total_asc">Lowest total</option>
            </Select>
            {vendor && (
              <span className="flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 dark:bg-brand-400/10 dark:text-brand-300">
                Vendor: {vendor.name}
                <button type="button" onClick={() => { setVendor(null); setPage(1); }} aria-label="Remove vendor filter"><X className="h-3 w-3" /></button>
              </span>
            )}
            {active && <button type="button" onClick={clearAll} className="text-sm font-semibold text-brand-600 dark:text-brand-300">Clear all</button>}
            <span className="ml-auto text-xs muted">{data ? `${number(data.total)} orders` : ''}</span>
          </div>
        </div>
        {error ? (
          <ErrorState error={error} onRetry={refetch} className="m-4" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr><th>Order ID</th><th>Date</th><th>Vendor</th><th>Item</th><th className="text-right">Order total</th><th>Payment</th><th>Fulfilment</th><th>Refund</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array.from({ length: 10 }, (_, i) => <tr key={i}><td colSpan={9}><Skeleton className="h-8" /></td></tr>)
                ) : data.items.length === 0 ? (
                  <tr><td colSpan={9} className="py-10 text-center text-sm muted">No orders match these filters.</td></tr>
                ) : (
                  data.items.map((o) => (
                    <tr key={o._id} className={cn(o.exceptions.length > 0 && 'bg-amber-50/40 dark:bg-amber-400/[0.03]')}>
                      <td>
                        <Link to={`/admin/orders/${o._id}`} className="font-mono text-xs font-semibold text-brand-600 hover:underline dark:text-brand-300">{o.orderNumber}</Link>
                        {o.exceptions.length > 0 && (
                          <p className="mt-0.5 flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300" title={o.exceptions.map((e) => e.reason).join('\n')}>
                            <AlertTriangle className="h-3 w-3" /> {o.exceptions.map((e) => EXCEPTION_LABELS[e.type]).join(', ')}
                          </p>
                        )}
                      </td>
                      <td className="text-xs whitespace-nowrap muted">{formatDateTime(o.createdAt)}</td>
                      <td className="text-sm">
                        {o.vendors.map((v) => (
                          <Link key={v._id} to={`/store/${v._id}`} target="_blank" rel="noreferrer" className="block max-w-[160px] truncate hover:text-brand-600">{v.storeName}</Link>
                        ))}
                      </td>
                      <td><ItemCell items={o.items} /></td>
                      <td className="text-right font-semibold tabular-nums">{money(o.total)}</td>
                      <td><StatusBadge status={o.payment.status} /></td>
                      <td>
                        <div className="flex flex-col gap-1">
                          {o.fulfilment.map((p) => <StatusBadge key={p._id} status={p.status} label={o.fulfilment.length > 1 ? `${p.storeName.split(' ')[0]}: ${p.status}` : undefined} />)}
                        </div>
                      </td>
                      <td className={cn('text-xs whitespace-nowrap', o.refund.status === 'failed' && 'font-semibold text-rose-600')}>
                        {REFUND_LABELS[o.refund.status] || o.refund.status}
                        {o.refund.amount > 0 && <span className="block muted">{money(o.refund.amount)}</span>}
                      </td>
                      <td><Link to={`/admin/orders/${o._id}`} className="btn btn-secondary btn-sm">View</Link></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Pagination className="mt-6" page={page} pages={data?.pages} onChange={setPage} />
    </div>
  );
}
