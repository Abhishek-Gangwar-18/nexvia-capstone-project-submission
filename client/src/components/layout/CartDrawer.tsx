import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, ShoppingBag, Sparkles, Truck, X } from 'lucide-react';
import { useCartStore } from '../../store/cart';
import { useAuth } from '../../store/auth';
import { useAuthModal } from '../../store/authModal';
import { useCart, useCartActions } from '../../lib/cart';
import { money } from '../../lib/format';
import QuantityStepper from '../ui/QuantityStepper';
import CartLineNotices from '../cart/CartLineNotices';
import { EmptyState } from '../ui/Feedback';

interface FreeShippingMeterProps {
  summary?: any;
}

export function FreeShippingMeter({ summary }: FreeShippingMeterProps) {
  const remaining = Math.max(0, summary.freeShippingThreshold - summary.subtotal);
  const progress = Math.min(100, (summary.subtotal / summary.freeShippingThreshold) * 100);
  return (
    <div className="rounded-2xl bg-gradient-to-r from-emerald-50 to-teal-50 p-3.5 dark:from-emerald-500/10 dark:to-teal-500/5">
      <p className="flex items-center gap-2 text-xs font-semibold text-emerald-800 dark:text-emerald-300">
        {remaining > 0 ? (
          <>
            <Truck className="h-4 w-4" /> Add {money(remaining)} more for FREE delivery
          </>
        ) : (
          <>
            <Sparkles className="h-4 w-4" /> You’ve unlocked FREE delivery!
          </>
        )}
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-emerald-100 dark:bg-emerald-500/10">
        <motion.div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-teal-500" initial={{ width: 0 }} animate={{ width: `${progress}%` }} transition={{ type: 'spring', damping: 20 }} />
      </div>
    </div>
  );
}

export default function CartDrawer() {
  const open = useCartStore((s) => s.drawerOpen);
  const close = useCartStore((s) => s.closeDrawer);
  const user = useAuth((s) => s.user);
  const { items, summary } = useCart();
  const { update, remove } = useCartActions();
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Checkout goes through the cart page first (coupons, delivery summary), then its own Checkout button.
  const checkout = () => {
    close();
    if (user) navigate('/cart');
    else useAuthModal.getState().open('login', { from: '/cart' });
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[75]">
          <motion.div className="absolute inset-0 bg-zinc-950/40 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close} />
          <motion.aside
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 32, stiffness: 320 }}
            className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-white shadow-2xl dark:bg-surface-dark"
          >
            <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-white/5">
              <div>
                <h2 className="font-display text-xl font-bold">Your cart</h2>
                <p className="text-xs muted">{summary.itemCount} item{summary.itemCount === 1 ? '' : 's'}</p>
              </div>
              <button type="button" onClick={close} className="btn-icon" aria-label="Close cart">
                <X className="h-5 w-5" />
              </button>
            </div>

            {items.length === 0 ? (
              <EmptyState
                icon={ShoppingBag}
                title="Your cart is empty"
                description="Discover thousands of products from independent sellers."
                action={
                  <Link to="/search" onClick={close} className="btn btn-primary">
                    Start shopping <ArrowRight className="h-4 w-4" />
                  </Link>
                }
                className="flex-1"
              />
            ) : (
              <>
                <div className="px-5 pt-4">
                  <FreeShippingMeter summary={summary} />
                </div>
                <ul className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
                  <AnimatePresence initial={false}>
                    {items.map((item) => (
                      <motion.li
                        key={item.productId}
                        layout
                        initial={{ opacity: 0, x: 30 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 60, height: 0, marginTop: 0 }}
                        className="flex gap-3 rounded-2xl border border-zinc-100 p-3 dark:border-white/5"
                      >
                        <Link to={`/product/${item.product._id}`} onClick={close} className="h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-zinc-50 dark:bg-white/5">
                          <img src={item.product.thumbnail} alt={item.product.title} className="h-full w-full object-contain p-1" />
                        </Link>
                        <div className="flex min-w-0 flex-1 flex-col">
                          <Link to={`/product/${item.product._id}`} onClick={close} className="line-clamp-2 text-sm font-semibold hover:text-brand-600">
                            {item.product.title}
                          </Link>
                          {item.vendor?.storeName && <p className="text-xs muted">Sold by {item.vendor.storeName}</p>}
                          <CartLineNotices item={item} />
                          {!item.inStock && <p className="text-xs font-semibold text-rose-600">Out of stock</p>}
                          <div className="mt-auto flex items-center justify-between pt-2">
                            <QuantityStepper size="sm" allowRemove value={item.quantity} max={item.maxQuantity || 10} onChange={(q) => (q <= 0 ? remove(item.productId) : update(item.productId, q))} />
                            <span className="font-bold">{money(item.lineTotal)}</span>
                          </div>
                        </div>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
                <div className="space-y-3 border-t border-zinc-100 bg-zinc-50/70 px-5 py-4 dark:border-white/5 dark:bg-white/[0.02]">
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="muted">Subtotal</span>
                      <span className="font-semibold">{money(summary.subtotal)}</span>
                    </div>
                    {summary.savings > 0 && (
                      <div className="flex justify-between text-emerald-600 dark:text-emerald-400">
                        <span>You save</span>
                        <span className="font-semibold">−{money(summary.savings)}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="muted">Delivery</span>
                      <span className="font-semibold">{summary.shipping ? money(summary.shipping) : 'FREE'}</span>
                    </div>
                  </div>
                  <button type="button" onClick={checkout} className="btn btn-primary btn-lg w-full justify-between">
                    <span>{user ? 'Checkout' : 'Sign in to checkout'}</span>
                    <span className="flex items-center gap-2">
                      {money(summary.total)} <ArrowRight className="h-4 w-4" />
                    </span>
                  </button>
                  <Link to="/cart" onClick={close} className="block text-center text-sm font-semibold text-brand-600 hover:underline dark:text-brand-300">
                    View full cart & apply coupons
                  </Link>
                </div>
              </>
            )}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
