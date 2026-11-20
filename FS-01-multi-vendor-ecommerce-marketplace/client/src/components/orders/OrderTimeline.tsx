import { motion } from 'framer-motion';
import { Check, ClipboardCheck, Home, PackageCheck, Truck, XCircle } from 'lucide-react';
import { cn, formatDateTime } from '../../lib/format';
import { PACKAGE_FLOW } from '../../lib/status';

const ICONS = { placed: ClipboardCheck, packed: PackageCheck, shipped: Truck, delivered: Home };
const LABELS = { placed: 'Ordered', packed: 'Packed', shipped: 'Shipped', delivered: 'Delivered' };

/** Horizontal tracker: Ordered → Packed → Shipped → Delivered, with timestamps from the package timeline. */
interface OrderTimelineProps {
  pkg?: any;
}

export default function OrderTimeline({ pkg }: OrderTimelineProps) {
  if (pkg.status === 'cancelled') {
    const cancelled = pkg.timeline.find((t) => t.status === 'cancelled');
    return (
      <div className="flex items-center gap-3 rounded-2xl bg-rose-50 p-4 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
        <XCircle className="h-5 w-5 shrink-0" />
        <div>
          <p className="font-semibold">Cancelled{cancelled ? ` on ${formatDateTime(cancelled.at)}` : ''}</p>
          {cancelled?.note && <p className="text-xs opacity-80">{cancelled.note}</p>}
          {pkg.refund?.amount > 0 && <p className="text-xs opacity-80">Refund of ₹{pkg.refund.amount} {pkg.refund.status === 'failed' ? 'failed — support will follow up' : 'initiated to the original payment method'}</p>}
        </div>
      </div>
    );
  }
  if (pkg.status === 'pending') {
    return <p className="rounded-2xl bg-amber-50 p-4 text-sm font-medium text-amber-800 dark:bg-amber-400/10 dark:text-amber-300">Waiting for payment confirmation</p>;
  }

  const current = PACKAGE_FLOW.indexOf(pkg.status);
  const at = (status) => pkg.timeline.find((t) => t.status === status)?.at;

  return (
    <div className="relative">
      <div className="absolute top-5 right-[12.5%] left-[12.5%] h-1 rounded-full bg-zinc-200 dark:bg-white/10">
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-brand-500 to-emerald-500"
          initial={{ width: 0 }}
          animate={{ width: `${(current / (PACKAGE_FLOW.length - 1)) * 100}%` }}
          transition={{ duration: 0.9, ease: 'easeOut' }}
        />
      </div>
      <ol className="relative grid grid-cols-4">
        {PACKAGE_FLOW.map((status, i) => {
          const Icon = ICONS[status];
          const done = i <= current;
          const active = i === current;
          return (
            <li key={status} className="flex flex-col items-center text-center">
              <motion.div
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: i * 0.12 }}
                className={cn(
                  'relative flex h-10 w-10 items-center justify-center rounded-full border-4 border-white transition-colors dark:border-surface-dark',
                  done ? (status === 'delivered' ? 'bg-emerald-500 text-white' : 'bg-brand-600 text-white') : 'bg-zinc-200 text-zinc-400 dark:bg-white/10',
                )}
              >
                {active && status !== 'delivered' && <span className="absolute inset-0 animate-ping rounded-full bg-brand-500/40" />}
                {done && !active ? <Check className="h-4 w-4" strokeWidth={3} /> : <Icon className="h-4 w-4" />}
              </motion.div>
              <p className={cn('mt-2 text-xs font-semibold sm:text-sm', !done && 'text-zinc-400')}>{LABELS[status]}</p>
              <p className="text-[10px] muted sm:text-[11px]">{at(status) ? formatDateTime(at(status)) : '—'}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
