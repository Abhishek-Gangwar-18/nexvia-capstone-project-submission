import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { BadgePercent, Check, Tag, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { cn, money } from '../../lib/format';
import { useCartStore } from '../../store/cart';
import { Spinner } from '../ui/Feedback';

/**
 * Coupon entry + list of available offers. Validates against the live cart via POST /cart/coupon
 * and re-validates whenever the cart subtotal changes. Reports the priced summary through onApplied.
 */
export default function CouponBox({ items, subtotal, onApplied, disabled }) {
  const couponCode = useCartStore((s) => s.couponCode);
  const setCouponCode = useCartStore((s) => s.setCouponCode);
  const couponCheck = useCartStore((s) => s.couponCheck);
  const [input, setInput] = useState('');
  const [applied, setApplied] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const vendorIds = [...new Set(items.map((i) => i.vendor?._id).filter(Boolean))].join(',');
  const { data: offers = [] } = useQuery({
    queryKey: ['coupons', vendorIds],
    queryFn: () => api.get('/coupons', { params: { vendors: vendorIds } }).then((r) => r.data.coupons),
    enabled: !disabled,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  /** quiet: no inline error. lost: the coupon was applied before, so say it was removed. */
  const apply = async (code, { quiet = false, lost = false } = {}) => {
    if (!code) return;
    setLoading(true);
    setError('');
    try {
      const { data } = await api.post('/cart/coupon', { code });
      setApplied(data.coupon);
      setCouponCode(data.coupon.code);
      setInput('');
      onApplied?.(data);
    } catch (err) {
      setApplied(null);
      setCouponCode('');
      onApplied?.(null);
      if (!quiet) setError(errorMessage(err));
      if (lost) toast.error(`Coupon ${code} was removed: ${errorMessage(err)}`, { id: 'coupon-lost', duration: 6000 });
    } finally {
      setLoading(false);
    }
  };

  const remove = () => {
    setApplied(null);
    setCouponCode('');
    onApplied?.(null);
  };

  // Re-validate the saved coupon when the cart changes (it may no longer meet the minimum).
  useEffect(() => {
    if (couponCode && !disabled && subtotal > 0) apply(couponCode, { quiet: true, lost: Boolean(applied) });
    else if (!subtotal) onApplied?.(null);
  }, [subtotal, disabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // A coupon changed on the server (switched off, expired, limits hit, deleted) or the tab regained focus:
  // re-check the applied one right away, and drop it with a notice if it no longer applies.
  useEffect(() => {
    if (couponCheck && couponCode && applied && !disabled) apply(couponCode, { quiet: true, lost: true });
  }, [couponCheck]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onFocus = () => useCartStore.getState().couponCode && useCartStore.getState().recheckCoupon();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (disabled) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 p-4 text-sm muted dark:border-white/15">
        <Tag className="mb-1 h-4 w-4" /> Sign in with a customer account to apply coupons.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <AnimatePresence mode="wait" initial={false}>
        {applied ? (
          <motion.div key="applied" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="flex items-center gap-3 rounded-2xl border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-400/30 dark:bg-emerald-400/10">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500 text-white">
              <BadgePercent className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-mono text-sm font-bold text-emerald-800 dark:text-emerald-300">{applied.code}</p>
              <p className="text-xs text-emerald-700 dark:text-emerald-400">You save {money(applied.discount)}</p>
            </div>
            <button type="button" onClick={remove} className="rounded-lg p-1.5 text-emerald-700 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-400/10" aria-label="Remove coupon">
              <X className="h-4 w-4" />
            </button>
          </motion.div>
        ) : (
          <motion.form
            key="form"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onSubmit={(e) => {
              e.preventDefault();
              apply(input.trim().toUpperCase());
            }}
          >
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Tag className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <input value={input} onChange={(e) => setInput(e.target.value.toUpperCase())} placeholder="Coupon code" className={cn('input pl-9 font-mono uppercase', error && 'input-error')} />
              </div>
              <button type="submit" disabled={!input || loading} className="btn btn-secondary">
                {loading ? <Spinner className="h-4 w-4" /> : 'Apply'}
              </button>
            </div>
            {error && <p className="field-error">{error}</p>}
          </motion.form>
        )}
      </AnimatePresence>

      {!applied && offers.length > 0 && (
        <div className="space-y-1.5">
          {offers.slice(0, 4).map((c) => (
            <button
              key={c._id}
              type="button"
              onClick={() => apply(c.code)}
              className="group flex w-full items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2 text-left text-xs transition hover:border-brand-300 hover:bg-brand-50/40 dark:border-white/10 dark:hover:bg-brand-500/5"
            >
              <span className="rounded-md border border-dashed border-brand-400 px-1.5 py-0.5 font-mono font-bold text-brand-700 dark:text-brand-300">{c.code}</span>
              <span className="flex-1 truncate muted">{c.description}</span>
              <Check className="h-3.5 w-3.5 text-brand-500 opacity-0 transition group-hover:opacity-100" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PriceBreakdown({ summary, discount = 0, shipping, total }) {
  const rows = [
    ['Items total (MRP)', money(summary.mrpTotal)],
    summary.savings > 0 && ['Product discount', `−${money(summary.savings)}`, 'text-emerald-600 dark:text-emerald-400'],
    discount > 0 && ['Coupon discount', `−${money(discount)}`, 'text-emerald-600 dark:text-emerald-400'],
    ['Delivery', shipping ? money(shipping) : 'FREE', !shipping && 'text-emerald-600 dark:text-emerald-400'],
  ].filter(Boolean);
  return (
    <div className="space-y-2.5 text-sm">
      {rows.map(([label, value, cls]) => (
        <div key={label} className="flex justify-between">
          <span className="muted">{label}</span>
          <span className={cn('font-semibold', cls)}>{value}</span>
        </div>
      ))}
      <div className="flex items-end justify-between border-t border-dashed border-zinc-200 pt-3 dark:border-white/10">
        <span className="font-semibold">Total payable</span>
        <motion.span key={total} initial={{ scale: 1.12, opacity: 0.6 }} animate={{ scale: 1, opacity: 1 }} className="inline-block font-display text-2xl font-bold">
          {money(total)}
        </motion.span>
      </div>
      {summary.savings + discount > 0 && (
        <p className="rounded-xl bg-emerald-50 px-3 py-2 text-center text-xs font-semibold text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
          🎉 You’re saving {money(summary.savings + discount)} on this order
        </p>
      )}
    </div>
  );
}
