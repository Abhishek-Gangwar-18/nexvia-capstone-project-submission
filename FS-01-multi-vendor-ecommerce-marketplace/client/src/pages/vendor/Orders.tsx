import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, MapPin, PackageCheck, Search, Truck, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { cn, formatDateTime, money, plural } from '../../lib/format';
import { CANCEL_REASON_LABELS, CANCEL_REASONS, cancelReasonValid, NEXT_ACTION } from '../../lib/status';
import { useDebounce } from '../../lib/hooks';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { Segmented } from '../../components/ui/Controls';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import Pagination from '../../components/ui/Pagination';
import OrderTimeline from '../../components/orders/OrderTimeline';
import { EmptyState, ErrorState, Skeleton, Spinner } from '../../components/ui/Feedback';

interface PackageCardProps {
  row?: any;
  onUpdate?: any;
}

function PackageCard({ row, onUpdate }: PackageCardProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shipModal, setShipModal] = useState(false);
  const [trackingId, setTrackingId] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancel, setCancel] = useState({ reasonCode: '', note: '' });
  const pkg = row.package;
  const next = NEXT_ACTION[pkg.status];

  const update = async (status, extra = {}) => {
    setBusy(true);
    try {
      await api.patch(`/vendor/orders/${row._id}/status`, { status, ...extra });
      toast.success(status === 'delivered' ? 'Delivered! Your payout is released once the return window ends 💸' : `Package marked ${status}`);
      setShipModal(false);
      setConfirmCancel(false);
      onUpdate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full flex-wrap items-center gap-x-6 gap-y-2 p-4 text-left">
        <div className="flex -space-x-2">
          {pkg.items.slice(0, 3).map((item) => (
            <img key={item.product} src={item.image} alt="" className="h-11 w-11 rounded-xl bg-white object-contain p-0.5 ring-2 ring-white dark:bg-zinc-800 dark:ring-surface-dark" />
          ))}
        </div>
        <div className="min-w-[150px] flex-1">
          <p className="font-mono text-sm font-semibold">{row.orderNumber}</p>
          <p className="text-xs muted">{formatDateTime(row.createdAt)} · {plural(pkg.items.reduce((s, i) => s + i.quantity, 0), 'unit')}</p>
        </div>
        <div className="text-sm">
          <p className="muted text-xs">Customer</p>
          <p className="font-medium">{row.shippingAddress.fullName}</p>
        </div>
        <div className="text-right text-sm">
          <p className="text-xs muted">Your earning</p>
          <p className="font-bold">{money(pkg.vendorEarning)}</p>
        </div>
        <StatusBadge status={pkg.status} pulse={pkg.status === 'placed'} />
        <ChevronDown className={cn('h-4 w-4 text-zinc-400 transition', open && 'rotate-180')} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden">
            <div className="space-y-5 border-t border-zinc-100 p-5 dark:border-white/5">
              <OrderTimeline pkg={pkg} />
              <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
                <ul className="space-y-2">
                  {pkg.items.map((item) => (
                    <li key={item.product} className="flex items-center gap-3 rounded-xl bg-zinc-50 p-2.5 dark:bg-white/[0.03]">
                      <img src={item.image} alt="" className="h-12 w-12 rounded-lg bg-white object-contain p-1 dark:bg-white/5" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{item.title}</p>
                        <p className="text-xs muted">{item.quantity} × {money(item.price)}</p>
                      </div>
                      <p className="text-sm font-semibold">{money(item.total)}</p>
                    </li>
                  ))}
                </ul>
                <div className="space-y-3 text-sm">
                  <div className="rounded-xl border border-zinc-100 p-3 dark:border-white/5">
                    <p className="flex items-center gap-1.5 text-xs font-semibold muted"><MapPin className="h-3.5 w-3.5" /> Ship to</p>
                    <p className="mt-1 font-medium">{row.shippingAddress.fullName} · {row.shippingAddress.phone}</p>
                    <p className="text-xs muted">{row.shippingAddress.line1}, {row.shippingAddress.city}, {row.shippingAddress.state} {row.shippingAddress.pincode}</p>
                  </div>
                  <div className="space-y-1 rounded-xl border border-zinc-100 p-3 text-xs dark:border-white/5">
                    <div className="flex justify-between"><span className="muted">Package total</span><span>{money(pkg.total)}</span></div>
                    {pkg.discount > 0 && <div className="flex justify-between"><span className="muted">Coupon share</span><span>−{money(pkg.discount)}</span></div>}
                    <div className="flex justify-between"><span className="muted">Commission ({pkg.commissionRate}%)</span><span>−{money(pkg.commission)}</span></div>
                    <div className="flex justify-between border-t border-zinc-100 pt-1 font-semibold dark:border-white/5"><span>You receive</span><span>{money(pkg.vendorEarning)}</span></div>
                  </div>
                </div>
              </div>
              {(next || ['placed', 'packed'].includes(pkg.status)) && (
                <div className="flex flex-wrap justify-end gap-2">
                  {['placed', 'packed'].includes(pkg.status) && (
                    <button type="button" onClick={() => setConfirmCancel(true)} className="btn btn-ghost text-rose-600">
                      <XCircle className="h-4 w-4" /> Cancel package
                    </button>
                  )}
                  {next && (
                    <button type="button" disabled={busy} onClick={() => (next.status === 'shipped' ? setShipModal(true) : update(next.status))} className="btn btn-primary">
                      {busy ? <Spinner className="h-4 w-4" /> : next.status === 'shipped' ? <Truck className="h-4 w-4" /> : <PackageCheck className="h-4 w-4" />} {next.label}
                    </button>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Modal
        open={shipModal}
        onClose={() => setShipModal(false)}
        title="Ship this package"
        description="Add the courier tracking number so the customer can follow the delivery."
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setShipModal(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => update('shipped', trackingId ? { trackingId } : {})}>
              {busy && <Spinner className="h-4 w-4" />} Mark as shipped
            </button>
          </>
        }
      >
        <label className="label" htmlFor="tracking">Tracking ID (optional)</label>
        <input id="tracking" value={trackingId} onChange={(e) => setTrackingId(e.target.value)} className="input font-mono" placeholder="Leave empty to auto-generate" />
      </Modal>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => (cancelReasonValid(cancel) ? update('cancelled', { reasonCode: cancel.reasonCode, note: cancel.note.trim() || undefined }) : toast.error('Choose a reason (and describe it for Other)'))}
        loading={busy}
        danger
        title="Cancel this package?"
        description={`Stock is restored and the customer is refunded ${money(pkg.total)}. Your payout for this package is reversed.`}
        confirmLabel="Cancel package"
      >
        <select aria-label="Cancellation reason" value={cancel.reasonCode} onChange={(e) => setCancel({ ...cancel, reasonCode: e.target.value })} className="input mt-3">
          <option value="">Choose a reason…</option>
          {CANCEL_REASONS.vendor.map((c) => <option key={c} value={c}>{CANCEL_REASON_LABELS[c]}</option>)}
        </select>
        <textarea value={cancel.note} onChange={(e) => setCancel({ ...cancel, note: e.target.value })} maxLength={180} rows={2} placeholder={cancel.reasonCode === 'other' ? 'Describe the reason (required)' : 'Note (optional)'} className="input mt-2" />
      </ConfirmDialog>
    </motion.div>
  );
}

export default function VendorOrders() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('placed');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounce(q, 300);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['vendor-orders', status, search, page],
    queryFn: () => api.get('/vendor/orders', { params: { status: status || undefined, q: search || undefined, page, limit: 10 } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const counts = data?.counts || {};

  const tabs = [
    { value: 'placed', label: 'New', count: counts.placed || 0 },
    { value: 'packed', label: 'Packed', count: counts.packed || 0 },
    { value: 'shipped', label: 'Shipped', count: counts.shipped || 0 },
    { value: 'delivered', label: 'Delivered' },
    { value: 'cancelled', label: 'Cancelled' },
    { value: '', label: 'All' },
  ];

  const onUpdate = () => {
    refetch();
    queryClient.invalidateQueries({ queryKey: ['vendor-dashboard'] });
  };

  return (
    <div>
      <PageHeader title="Orders" description="Pack, ship and deliver your packages. Each payout is held through the return window after delivery, then released to you." />
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="overflow-x-auto scrollbar-none">
          <Segmented size="sm" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={tabs} />
        </div>
        <div className="relative lg:w-64">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search order number" className="input py-2 pl-9" />
        </div>
      </div>
      <div className="space-y-3">
        {error ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : isLoading ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20" />)
        ) : !data.items.length ? (
          <EmptyState icon={PackageCheck} title={status === 'placed' ? 'All caught up!' : 'No orders here'} description={status === 'placed' ? 'New orders will appear here as soon as customers pay.' : 'Try another tab.'} />
        ) : (
          data.items.map((row) => <PackageCard key={`${row._id}-${row.package._id}`} row={row} onUpdate={onUpdate} />)
        )}
      </div>
      <Pagination className="mt-6" page={page} pages={data?.pages} onChange={setPage} />
    </div>
  );
}
