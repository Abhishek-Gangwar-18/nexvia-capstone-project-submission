import { motion } from 'framer-motion';
import { Check, X } from 'lucide-react';
import toast, { type Toast } from 'react-hot-toast';

const DURATION_MS = 6_000;
const CONFETTI = ['#34d399', '#fbbf24', '#f472b6', '#818cf8', '#38bdf8', '#a3e635'];

interface Props {
  t: Toast;
  orderNumber: string;
  sellers: string[];
}

/**
 * "Payment successful, order placed" as one floating card at the bottom centre: nothing on the page moves when it
 * appears or leaves. A burst of confetti around the check, the seller(s) preparing it, and a bar showing how long it
 * stays (hovering pauses it, like every toast).
 */
function OrderPlacedToast({ t, orderNumber, sellers }: Props) {
  const who = sellers.length === 1 ? sellers[0] : `${sellers.length} sellers`;
  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.94 }}
      animate={t.visible ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 16, scale: 0.96 }}
      transition={{ type: 'spring', damping: 22, stiffness: 300 }}
      className="group pointer-events-auto relative w-[min(92vw,420px)] overflow-hidden rounded-2xl bg-zinc-900 text-zinc-50 shadow-2xl shadow-emerald-900/30 ring-1 ring-white/10"
    >
      <div className="flex items-center gap-4 p-4 pr-10">
        <div className="relative flex h-12 w-12 shrink-0 items-center justify-center">
          {CONFETTI.flatMap((color, i) => [0, 1].map((k) => {
            const angle = ((i * 2 + k) / (CONFETTI.length * 2)) * Math.PI * 2;
            return (
              <motion.span
                key={`${i}-${k}`}
                aria-hidden="true"
                className="absolute h-1.5 w-1.5 rounded-[2px]"
                style={{ background: color }}
                initial={{ x: 0, y: 0, opacity: 1, scale: 0.4, rotate: 0 }}
                animate={{ x: Math.cos(angle) * 30, y: Math.sin(angle) * 30, opacity: 0, scale: 1, rotate: 180 }}
                transition={{ duration: 0.9, delay: 0.15 + k * 0.08, ease: 'easeOut' }}
              />
            );
          }))}
          <motion.div
            initial={{ scale: 0, rotate: -45 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', damping: 12, stiffness: 260, delay: 0.05 }}
            className="relative flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 shadow-lg shadow-emerald-500/30"
          >
            <Check className="h-6 w-6 text-white" strokeWidth={3} />
          </motion.div>
        </div>
        <div className="min-w-0">
          <p className="font-display text-base font-bold">Payment successful — order placed!</p>
          <p className="mt-0.5 truncate text-sm text-zinc-400">
            <span className="font-semibold text-zinc-200">{who}</span> {sellers.length === 1 ? 'is' : 'are'} preparing your order
          </p>
          <p className="mt-1 font-mono text-xs tracking-wide text-zinc-500">Order #{orderNumber}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => toast.dismiss(t.id)}
        className="absolute top-2.5 right-2.5 rounded-lg p-1.5 text-zinc-400 transition hover:bg-white/10 hover:text-white"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
      {/* Time left: shrinks over the toast's duration and stops while hovered (react-hot-toast pauses then). */}
      <span
        aria-hidden="true"
        className="absolute bottom-0 left-0 h-0.5 w-full origin-left bg-gradient-to-r from-emerald-400 to-teal-400 animate-[order-toast-timer_6s_linear_forwards] group-hover:[animation-play-state:paused]"
      />
    </motion.div>
  );
}

/** Shows the order-placed celebration once (the fixed id stops a second copy, e.g. on a quick re-render). */
export function showOrderPlaced(order: { _id: string; orderNumber: string; packages: { storeName: string }[] }) {
  const sellers = [...new Set(order.packages.map((p) => p.storeName))];
  toast.custom((t) => <OrderPlacedToast t={t} orderNumber={order.orderNumber} sellers={sellers} />, {
    id: `order-placed-${order._id}`,
    duration: DURATION_MS,
    position: 'bottom-center',
  });
}
