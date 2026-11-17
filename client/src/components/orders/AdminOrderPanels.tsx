import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, History } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { cn, formatDateTime, money } from '../../lib/format';
import { CANCEL_REASON_LABELS, CANCEL_REASONS, cancelReasonValid, NEXT_ACTION } from '../../lib/status';
import { ConfirmDialog } from '../ui/Modal';
import { Spinner } from '../ui/Feedback';

const eventAt = (pkg, status) => pkg.timeline.find((t) => t.status === status)?.at;

/** Next valid transition plus cancel (with a required reason) for placed/packed packages. */
interface AdminPackageActionsProps {
  order?: any;
  pkg?: any;
  onDone?: any;
}

export function AdminPackageActions({ order, pkg, onDone }: AdminPackageActionsProps) {
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancel, setCancel] = useState({ reasonCode: '', note: '' });
  const next = NEXT_ACTION[pkg.status];
  const run = async (body) => {
    setBusy(true);
    try {
      await api.patch(`/admin/orders/${order._id}/packages/${pkg._id}`, body);
      toast.success(`Package marked ${body.status}`);
      setCancelOpen(false);
      setCancel({ reasonCode: '', note: '' });
      onDone();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const cancellable = ['placed', 'packed'].includes(pkg.status);
  if (!next && !cancellable) return null;
  const paid = order.payment.status === 'paid';
  return (
    <div className="flex flex-wrap gap-2 border-t border-zinc-100 px-5 py-3 dark:border-white/5">
      {next && (
        <button type="button" disabled={busy} onClick={() => run({ status: next.status })} className="btn btn-primary btn-sm">
          {busy && <Spinner className="h-3.5 w-3.5" />} {next.label}
        </button>
      )}
      {cancellable && (
        <button type="button" disabled={busy} onClick={() => setCancelOpen(true)} className="btn btn-secondary btn-sm text-rose-600">
          Cancel package
        </button>
      )}
      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => (cancelReasonValid(cancel) ? run({ status: 'cancelled', reasonCode: cancel.reasonCode, note: cancel.note.trim() || undefined }) : toast.error('Choose a reason (and describe it for Other)'))}
        loading={busy}
        danger
        title={`Cancel the ${pkg.storeName} package?`}
        description={paid ? `Stock is restocked and ${money(pkg.total)} (plus shipping if this is the last package) is refunded to the customer.` : 'Stock is restocked. The order is unpaid, so nothing is refunded.'}
        confirmLabel="Cancel package"
      >
<select value={cancel.reasonCode} onChange={(e) => setCancel({ ...cancel, reasonCode: e.target.value })} className="input mt-3">
          <option value="">Choose a reason…</option>
          {CANCEL_REASONS.admin.map((c) => <option key={c} value={c}>{CANCEL_REASON_LABELS[c]}</option>)}
        </select>
        <textarea value={cancel.note} onChange={(e) => setCancel({ ...cancel, note: e.target.value })} maxLength={180} rows={2} placeholder={cancel.reasonCode === 'other' ? 'Describe the reason (required)' : 'Note (optional)'} className="input mt-2" />
      </ConfirmDialog>
    </div>
  );
}

/** Vendor link, tracking, dispatch/delivery times and the refund record for one package. */
interface AdminPackageInfoProps {
  pkg?: any;
}

export function AdminPackageInfo({ pkg }: AdminPackageInfoProps) {
  const shipped = eventAt(pkg, 'shipped');
  const delivered = eventAt(pkg, 'delivered');
  const r = pkg.refund;
  return (
    <div className="space-y-2 border-t border-zinc-100 px-5 py-3 text-xs dark:border-white/5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div><p className="muted">Vendor</p><Link to={`/store/${pkg.vendor}`} target="_blank" rel="noreferrer" className="font-semibold text-brand-600 hover:underline dark:text-brand-300">{pkg.storeName}</Link></div>
        <div><p className="muted">Tracking ID</p><p className="font-mono font-semibold">{pkg.trackingId || '—'}</p></div>
        <div><p className="muted">Dispatched</p><p className="font-semibold">{shipped ? formatDateTime(shipped) : '—'}</p></div>
        <div><p className="muted">Delivered</p><p className="font-semibold">{delivered ? formatDateTime(delivered) : '—'}</p></div>
      </div>
      {r?.status && (
        <div className={cn('rounded-lg p-2.5', r.status === 'failed' ? 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300' : 'bg-zinc-50 dark:bg-white/5')}>
          <p className="font-semibold">
            {r.status === 'failed' && <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />}
            Refund {r.status} · {money(r.amount)}{r.at ? ` · ${formatDateTime(r.at)}` : ''}
          </p>
          {r.id && <p className="font-mono">Provider ref {r.id}</p>}
          {r.error && <p>Error: {r.error}. Needs manual follow-up (retry ships with the payments redesign).</p>}
        </div>
      )}
    </div>
  );
}

/** Payment references and cancellation summary for the admin sidebar. */
interface AdminPaymentRefsProps {
  order?: any;
}

export function AdminPaymentRefs({ order }: AdminPaymentRefsProps) {
  const cancelled = order.packages.filter((p) => p.status === 'cancelled');
  const rows = [
    ['Gateway order', order.payment.gatewayOrderId],
    ['Paid at', order.payment.paidAt && formatDateTime(order.payment.paidAt)],
    ['Placed at', order.placedAt && formatDateTime(order.placedAt)],
    ['Stock reservation', order.reservation?.status],
  ].filter(([, v]) => v);
  return (
    <div className="mt-4 space-y-2 border-t border-dashed border-zinc-200 pt-4 text-sm dark:border-white/10">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4"><span className="muted">{k}</span><span className="truncate font-mono text-xs">{v}</span></div>
      ))}
      {cancelled.length > 0 && (
        <p className="rounded-lg bg-rose-50 p-2.5 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          {cancelled.length} of {order.packages.length} package{order.packages.length > 1 ? 's' : ''} cancelled: {cancelled.map((p) => p.storeName).join(', ')}
        </p>
      )}
    </div>
  );
}

/** Every order and package event in one chronological list. */
interface AdminEventLogProps {
  order?: any;
}

export function AdminEventLog({ order }: AdminEventLogProps) {
  const events = [
    { at: order.createdAt, label: 'Order created', note: `${order.packages.length} package(s) · ${money(order.pricing.total)}` },
    order.payment.paidAt && { at: order.payment.paidAt, label: 'Payment confirmed', note: [order.payment.provider, order.payment.method, order.payment.paymentId].filter(Boolean).join(' · ') },
    ...order.packages.flatMap((p) => [
      ...p.timeline.map((t) => ({ at: t.at, label: `${p.storeName}: ${t.status}`, note: t.note, tone: t.status === 'cancelled' ? 'rose' : undefined })),
      p.refund?.status && p.refund.at && { at: p.refund.at, label: `${p.storeName}: refund ${p.refund.status}`, note: money(p.refund.amount), tone: p.refund.status === 'failed' ? 'rose' : 'emerald' },
    ]),
  ]
    .filter(Boolean)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return (
    <div className="card p-5">
      <h3 className="flex items-center gap-2 font-semibold"><History className="h-4 w-4 text-brand-600" /> Timeline</h3>
      <ol className="mt-3 space-y-3 border-l border-zinc-200 pl-4 text-sm dark:border-white/10">
        {events.map((e, i) => (
          <li key={i} className="relative">
            <span className={cn('absolute top-1.5 -left-[21px] h-2.5 w-2.5 rounded-full', e.tone === 'rose' ? 'bg-rose-500' : e.tone === 'emerald' ? 'bg-emerald-500' : 'bg-brand-500')} />
            <p className="font-medium">{e.label}</p>
            {e.note && <p className="text-xs muted">{e.note}</p>}
            <p className="text-[11px] muted">{formatDateTime(e.at)}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
