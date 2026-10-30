import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { formatDate, money } from '../../lib/format';
import { RETURN_REASON_LABELS } from '../../lib/status';
import StatusBadge from '../ui/StatusBadge';
import { Modal } from '../ui/Modal';
import { Spinner } from '../ui/Feedback';
import ImageUploader from '../ui/ImageUploader';

const DAY = 24 * 60 * 60 * 1000;
const COUNTED = ['requested', 'approved', 'received', 'refunded'];

/** Last day a delivered package can be returned (null when not delivered). */
export function returnDeadline(pkg, windowDays) {
  const delivered = pkg.timeline?.find((t) => t.status === 'delivered')?.at;
  return delivered ? new Date(new Date(delivered).getTime() + windowDays * DAY) : null;
}

function ReturnForm({ order, pkg, returns, onDone }) {
  const returned = new Map();
  returns.filter((r) => COUNTED.includes(r.status)).forEach((r) => r.items.forEach((i) => returned.set(String(i.product), (returned.get(String(i.product)) || 0) + i.quantity)));
  const lines = pkg.items.map((i) => ({ ...i, left: i.quantity - (returned.get(String(i.product)) || 0) })).filter((i) => i.left > 0);
  const [qty, setQty] = useState(Object.fromEntries(lines.map((l) => [l.product, 0])));
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState([]);
  const queryClient = useQueryClient();

  const submit = useMutation({
    mutationFn: () =>
      api.post(`/orders/${order._id}/returns`, {
        packageId: pkg._id,
        items: Object.entries(qty).filter(([, q]) => q > 0).map(([product, quantity]) => ({ product, quantity })),
        reasonCode,
        note: note.trim() || undefined,
        photos,
      }),
    onSuccess: () => {
      toast.success('Return requested. The seller will review it.');
      queryClient.invalidateQueries({ queryKey: ['order-returns', order._id] });
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const chosen = Object.values(qty).some((q) => q > 0);
  const valid = chosen && reasonCode && (reasonCode !== 'other' || note.trim().length >= 3);
  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {lines.map((l) => (
          <li key={l.product} className="flex items-center gap-3 rounded-xl border border-zinc-200 p-2 dark:border-white/10">
            <img src={l.image} alt="" className="h-10 w-10 rounded-lg object-contain" />
            <p className="min-w-0 flex-1 truncate text-sm">{l.title}</p>
            <select value={qty[l.product]} onChange={(e) => setQty({ ...qty, [l.product]: Number(e.target.value) })} className="input w-auto py-1.5 text-sm">
              {Array.from({ length: l.left + 1 }, (_, n) => <option key={n} value={n}>{n === 0 ? 'Keep' : `Return ${n}`}</option>)}
            </select>
          </li>
        ))}
      </ul>
      <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} className="input">
        <option value="">Why are you returning it?</option>
        {Object.entries(RETURN_REASON_LABELS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
      </select>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} placeholder={reasonCode === 'other' ? 'Describe the problem (required)' : 'Anything the seller should know? (optional)'} className="input" />
      <div>
        <p className="label">Photos (optional, up to 5)</p>
        <ImageUploader value={photos} onChange={setPhotos} max={5} folder="returns" />
      </div>
      <p className="text-xs muted">You get back exactly what you paid for these items. Shipping is refunded when the whole order comes back.</p>
      <button type="button" disabled={!valid || submit.isPending} onClick={() => submit.mutate()} className="btn btn-primary w-full">
        {submit.isPending && <Spinner className="h-4 w-4" />} Request return
      </button>
    </div>
  );
}

/** Returns of one delivered package: their progress, and a "Return items" action inside the window. */
export default function PackageReturns({ order, pkg, returns, windowDays }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const withdraw = useMutation({
    mutationFn: (id) => api.post(`/returns/${id}/cancel`),
    onSuccess: () => {
      toast.success('Return withdrawn');
      queryClient.invalidateQueries({ queryKey: ['order-returns', order._id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const mine = returns.filter((r) => String(r.package) === String(pkg._id));
  const deadline = returnDeadline(pkg, windowDays);
  const canReturn = pkg.status === 'delivered' && deadline && Date.now() <= deadline.getTime() && !['releasing', 'released'].includes(pkg.payout?.status);
  if (!mine.length && !canReturn) return null;

  return (
    <div className="space-y-2 border-t border-zinc-100 px-5 py-3 dark:border-white/5">
      {mine.map((r) => (
        <div key={r._id} className="flex flex-wrap items-center gap-2 text-sm">
          <RotateCcw className="h-4 w-4 text-zinc-400" />
          <span>{r.items.map((i) => `${i.quantity} × ${i.title}`).join(', ')}</span>
          <StatusBadge status={r.status} />
          <span className="text-xs muted">refund {money(r.amount)}</span>
          {r.vendorNote && <span className="text-xs muted">· {r.vendorNote}</span>}
          {r.status === 'requested' && (
            <button type="button" disabled={withdraw.isPending} onClick={() => withdraw.mutate(r._id)} className="ml-auto text-xs font-semibold text-rose-600">Withdraw</button>
          )}
        </div>
      ))}
      {canReturn && (
        <button type="button" onClick={() => setOpen(true)} className="btn btn-secondary btn-sm">
          <RotateCcw className="h-3.5 w-3.5" /> Return items <span className="font-normal muted">· until {formatDate(deadline)}</span>
        </button>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={`Return items from ${pkg.storeName}`} size="md">
        {open && <ReturnForm order={order} pkg={pkg} returns={mine} onDone={() => setOpen(false)} />}
      </Modal>
    </div>
  );
}
