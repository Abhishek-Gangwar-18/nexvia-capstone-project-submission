import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { sellerHome } from '../lib/roles';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Heart, Lock, ShoppingBag, Store, Trash2 } from 'lucide-react';
import { useAuth } from '../store/auth';
import { useAuthModal } from '../store/authModal';
import { useCart, useCartActions } from '../lib/cart';
import { useWishlist } from '../lib/hooks';
import { money, plural } from '../lib/format';
import QuantityStepper from '../components/ui/QuantityStepper';
import Price from '../components/ui/Price';
import { EmptyState, PageLoader } from '../components/ui/Feedback';
import { StoreAvatar } from '../components/ui/Brand';
import CouponBox, { PriceBreakdown } from '../components/checkout/CouponBox';
import { FreeShippingMeter } from '../components/layout/CartDrawer';
import CartLineNotices from '../components/cart/CartLineNotices';

export function groupByVendor(items) {
  const groups = new Map();
  items.forEach((item) => {
    const key = item.vendor?._id || 'unknown';
    if (!groups.has(key)) groups.set(key, { vendor: item.vendor, items: [] });
    groups.get(key).items.push(item);
  });
  return [...groups.values()];
}

export default function Cart() {
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();
  const { items, summary, isLoading, isGuest } = useCart();
  const { update, remove } = useCartActions();
  const wishlist = useWishlist();
  const [priced, setPriced] = useState(null);

  // Only customers have a cart: sellers and admins are sent to their own area.
  const own = sellerHome(user);
  if (own) return <Navigate to={own.to} replace />;
  if (isLoading) return <PageLoader />;

  if (!items.length) {
    return (
      <div className="container-page py-10">
        <EmptyState
          icon={ShoppingBag}
          title="Your cart is empty"
          description="Looks like you haven’t added anything yet. Explore products from our independent sellers."
          action={
            <Link to="/search" className="btn btn-primary btn-lg">
              Explore products <ArrowRight className="h-4 w-4" />
            </Link>
          }
        />
      </div>
    );
  }

  const groups = groupByVendor(items);
  const discount = priced?.summary.discount || 0;
  const shipping = priced ? priced.summary.shipping : summary.shipping;
  const total = priced ? priced.summary.total : summary.total;
  const hasOutOfStock = items.some((i) => !i.inStock);

  const saveForLater = async (item) => {
    if (!wishlist.has(item.productId)) wishlist.toggle(item.productId);
    await remove(item.productId);
  };

  return (
    <div className="container-page py-8">
      <h1 className="font-display text-3xl font-bold tracking-tight">Shopping cart</h1>
      <p className="mt-1 text-sm muted">
        {plural(summary.itemCount, 'item')} from {plural(groups.length, 'seller')} · ships as {plural(groups.length, 'package')}
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          {groups.map((group) => (
            <motion.div key={group.vendor?._id} layout className="card overflow-hidden">
              <div className="flex items-center gap-3 border-b border-zinc-100 bg-zinc-50/60 px-5 py-3 dark:border-white/5 dark:bg-white/[0.02]">
                <StoreAvatar store={group.vendor} size="h-8 w-8" rounded="rounded-lg" />
                <p className="text-sm">
                  <span className="muted">Sold by </span>
                  <Link to={`/store/${group.vendor?._id}`} className="font-semibold hover:text-brand-600">{group.vendor?.storeName}</Link>
                </p>
                <Store className="ml-auto h-4 w-4 text-zinc-300" />
              </div>
              <ul className="divide-y divide-zinc-100 dark:divide-white/5">
                <AnimatePresence initial={false}>
                  {group.items.map((item) => (
                    <motion.li key={item.productId} layout exit={{ opacity: 0, x: -40 }} className="flex gap-4 p-5">
                      <Link to={`/product/${item.product._id}`} className="h-24 w-24 shrink-0 overflow-hidden rounded-2xl bg-zinc-50 sm:h-28 sm:w-28 dark:bg-white/5">
                        <img src={item.product.thumbnail} alt={item.product.title} className="h-full w-full object-contain p-2" />
                      </Link>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex justify-between gap-4">
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-brand-600 dark:text-brand-300">{item.product.brand}</p>
                            <Link to={`/product/${item.product._id}`} className="line-clamp-2 font-semibold hover:text-brand-600">{item.product.title}</Link>
                          </div>
                          <p className="font-display text-lg font-bold whitespace-nowrap">{money(item.lineTotal)}</p>
                        </div>
                        <Price price={item.product.price} mrp={item.product.mrp} size="sm" className="mt-1" />
                        <CartLineNotices item={item} className="mt-1" />
                        {!item.inStock && <p className="mt-1 text-xs font-semibold text-rose-600">Out of stock — remove to continue</p>}
                        <div className="mt-auto flex flex-wrap items-center gap-3 pt-3">
                          <QuantityStepper size="sm" allowRemove value={item.quantity} max={item.maxQuantity || 10} onChange={(q) => (q <= 0 ? remove(item.productId) : update(item.productId, q))} disabled={!item.inStock} />
                          {wishlist.canUse && (
                            <button type="button" onClick={() => saveForLater(item)} className="flex items-center gap-1 text-xs font-semibold text-zinc-500 hover:text-brand-600">
                              <Heart className="h-3.5 w-3.5" /> Save for later
                            </button>
                          )}
                          <button type="button" onClick={() => remove(item.productId)} className="flex items-center gap-1 text-xs font-semibold text-zinc-500 hover:text-rose-600">
                            <Trash2 className="h-3.5 w-3.5" /> Remove
                          </button>
                        </div>
                      </div>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </motion.div>
          ))}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-36 lg:self-start">
          <FreeShippingMeter summary={summary} />
          <div className="card space-y-5 p-5">
            <div>
              <p className="mb-3 font-semibold">Coupons & offers</p>
              <CouponBox items={items} subtotal={summary.subtotal} onApplied={setPriced} disabled={isGuest || user?.role !== 'customer'} />
            </div>
            <PriceBreakdown summary={summary} discount={discount} shipping={shipping} total={total} />
            <button
              type="button"
              disabled={hasOutOfStock}
              onClick={() => (user ? navigate('/checkout') : useAuthModal.getState().open('login', { from: '/checkout' }))}
              className="btn btn-primary btn-lg w-full"
            >
              <Lock className="h-4 w-4" /> {user ? 'Proceed to checkout' : 'Sign in to checkout'}
            </button>
            <p className="text-center text-[11px] muted">Payments are split securely between sellers and Vendora via Stripe Connect.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
