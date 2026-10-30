import { RotateCcw } from 'lucide-react';
import { formatDateTime, money } from '../../lib/format';
import StatusBadge from '../ui/StatusBadge';

const REASONS = { cancellation: 'Cancelled package', return: 'Returned items', unfulfillable: 'Couldn’t be fulfilled' };
const STATES = {
  pending: { status: 'pending', label: 'Processing' },
  succeeded: { status: 'succeeded', label: 'Sent to your bank' },
  failed: { status: 'failed', label: 'Failed' },
};

/** Customer view of every refund on an order: how much came back, for what, and where each one stands. */
export default function RefundsCard({ refunds, total }) {
  const sent = refunds.filter((r) => r.status === 'succeeded').reduce((sum, r) => sum + r.amount, 0);
  const processing = refunds.some((r) => r.status === 'pending');
  const failed = refunds.some((r) => r.status === 'failed');

  return (
    <div className="card p-5">
      <h3 className="flex items-center gap-2 font-semibold"><RotateCcw className="h-4 w-4 text-brand-600" /> Refunds</h3>
      <p className="mt-2 text-sm">
        <span className="font-display text-lg font-bold">{money(sent)}</span> <span className="muted">of {money(total)} refunded</span>
      </p>

      <ul className="mt-3 divide-y divide-zinc-100 text-sm dark:divide-white/10">
        {refunds.map((r) => {
          const state = STATES[r.status] || STATES.pending;
          return (
            <li key={r._id} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold">{money(r.amount)}</span>
                <StatusBadge status={state.status} label={state.label} pulse={r.status === 'pending'} />
              </div>
              <p className="mt-0.5 text-xs muted">
                {REASONS[r.reason] || 'Refund'}{r.storeName ? ` · ${r.storeName}` : ''} · {formatDateTime(r.createdAt)}
              </p>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 space-y-1.5 border-t border-dashed border-zinc-200 pt-3 text-xs muted dark:border-white/10">
        <p>Refunds go back to the card or account you paid with. Banks usually show them within 5–10 business days after they’re sent.</p>
        {processing && <p>“Processing” means the payment provider is still handling it; this page updates once it’s sent.</p>}
        {failed && <p className="text-rose-600 dark:text-rose-400">A refund didn’t go through. Our team retries failed refunds; you don’t need to do anything.</p>}
      </div>
    </div>
  );
}
