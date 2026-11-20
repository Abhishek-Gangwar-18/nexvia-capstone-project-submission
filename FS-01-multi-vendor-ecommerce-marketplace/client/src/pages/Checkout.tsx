import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Check, ChevronLeft, Lock, MapPin, Package, Plus, ShieldCheck, ShoppingBag, Truck,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useCart } from '../lib/cart';
import { refreshMe } from '../lib/session';
import { cn, deliveryEstimate, money, plural } from '../lib/format';
import { useAuth } from '../store/auth';
import { useCartStore } from '../store/cart';
import AddressForm from '../components/account/AddressForm';
import CouponBox, { PriceBreakdown } from '../components/checkout/CouponBox';
import MockPaymentModal from '../components/checkout/MockPaymentModal';
import StripePaymentModal from '../components/checkout/StripePaymentModal';
import { EmptyState, PageLoader, Spinner } from '../components/ui/Feedback';
import { StoreAvatar } from '../components/ui/Brand';
import { groupByVendor } from './Cart';

const STEPS = ['Delivery address', 'Review & pay'];

interface StepperProps {
  step?: any;
}

function Stepper({ step }: StepperProps) {
  return (
    <div className="card flex items-center gap-3 p-4">
      {STEPS.map((label, i) => {
        const index = i + 1;
        const done = step > index;
        const active = step === index;
        return (
          <div key={label} className="flex flex-1 items-center gap-3">
            <motion.div
              animate={{ scale: active ? 1.08 : 1 }}
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold transition-colors',
                done ? 'bg-emerald-500 text-white' : active ? 'bg-gradient-to-br from-brand-500 to-indigo-600 text-white shadow-lg shadow-brand-600/30' : 'bg-zinc-100 text-zinc-400 dark:bg-white/10',
              )}
            >
              {done ? <Check className="h-4 w-4" /> : index}
            </motion.div>
            <span className={cn('text-sm font-semibold', !active && !done && 'text-zinc-400')}>{label}</span>
            {i < STEPS.length - 1 && (
              <div className="relative h-0.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-white/10">
                <motion.div className="absolute inset-y-0 left-0 bg-emerald-500" animate={{ width: done ? '100%' : '0%' }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Checkout() {
  const user = useAuth((s) => s.user);
  const setUser = useAuth((s) => s.setUser);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { items, summary, isLoading } = useCart();
  const couponCode = useCartStore((s) => s.couponCode);
  const setCouponCode = useCartStore((s) => s.setCouponCode);
  const [step, setStep] = useState(1);
  const [addressId, setAddressId] = useState(null);
  const [addingAddress, setAddingAddress] = useState(false);
  const [priced, setPriced] = useState(null);
  const [placing, setPlacing] = useState(false);
  const [mockCheckout, setMockCheckout] = useState(null);
  const [stripeCheckout, setStripeCheckout] = useState(null);
  // One key per visit to checkout: retries of "Place order" reuse it, so the server never creates a duplicate order.
  const checkoutKey = useRef(crypto.randomUUID());
  const finished = useRef(false);

  const profile = useQuery({ queryKey: ['me'], queryFn: () => refreshMe() });
  const addresses = profile.data?.addresses || user?.addresses || [];

  useEffect(() => {
    if (!addressId && addresses.length) setAddressId((addresses.find((a) => a.isDefault) || addresses[0])._id);
    if (!profile.isLoading && !addresses.length) setAddingAddress(true);
  }, [addresses, addressId, profile.isLoading]);

  const addAddress = useMutation({
    mutationFn: (payload: any) => api.post('/auth/me/addresses', payload).then((r) => r.data),
    onSuccess: (data) => {
      const updated = { ...useAuth.getState().user, addresses: data.addresses };
      setUser(updated);
      queryClient.setQueryData(['me'], updated);
      setAddressId(data.address._id);
      setAddingAddress(false);
      toast.success('Address saved');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (isLoading || profile.isLoading) return <PageLoader label="Preparing checkout…" />;

  if (!items.length && !mockCheckout && !stripeCheckout && !finished.current) {
    return (
      <div className="container-page py-10">
        <EmptyState icon={ShoppingBag} title="Nothing to check out" description="Your cart is empty." action={<Link to="/search" className="btn btn-primary">Continue shopping</Link>} />
      </div>
    );
  }

  const address = addresses.find((a) => a._id === addressId);
  const groups = groupByVendor(items);
  const discount = priced?.summary.discount || 0;
  const shipping = priced ? priced.summary.shipping : summary.shipping;
  const total = priced ? priced.summary.total : summary.total;

  const finish = (order) => {
    finished.current = true;
    setCouponCode('');
    queryClient.invalidateQueries({ queryKey: ['cart'] });
    queryClient.invalidateQueries({ queryKey: ['orders'] });
    navigate(`/orders/${order._id}?placed=1`, { replace: true });
  };

  const placeOrder = async () => {
    if (!addressId) return toast.error('Choose a delivery address');
    setPlacing(true);
    let created;
    try {
      const { data } = await api.post(
        '/orders/checkout',
        // expectedTotal: the server refuses if the real total differs (a price, fee or coupon changed meanwhile).
        { addressId, couponCode: couponCode || undefined, expectedTotal: total },
        { headers: { 'Idempotency-Key': checkoutKey.current } },
      );
      created = data;
      if (data.payment.provider === 'mock') setMockCheckout(data);
      else setStripeCheckout(data);
      return undefined;
    } catch (error) {
      if (created) return navigate(`/orders/${created.order._id}`);
      // Stock dropped since the cart was loaded: show the corrected quantities right away.
      if (error.response?.data?.details?.code === 'CART_CHANGED') queryClient.invalidateQueries({ queryKey: ['cart'] });
      // The coupon may have been switched off since it was applied: re-check it so the totals are right.
      if (couponCode) useCartStore.getState().recheckCoupon();
      return toast.error(errorMessage(error), { duration: 6000 });
    } finally {
      setPlacing(false);
    }
  };

  const onMockResult = async (outcome) => {
    try {
      const { data } = await api.post(`/orders/${mockCheckout.order._id}/verify`, { outcome });
      setTimeout(() => finish(data.order), 1100);
      return true;
    } catch (error) {
      toast.error(errorMessage(error));
      return false;
    }
  };

  return (
    <div className="container-page py-8">
      <Link to="/cart" className="inline-flex items-center gap-1 text-sm font-semibold muted hover:text-brand-600">
        <ChevronLeft className="h-4 w-4" /> Back to cart
      </Link>
      <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Checkout</h1>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px] [&>*]:min-w-0">
        <div className="space-y-4">
          <Stepper step={step} />

          <AnimatePresence mode="wait">
            {step === 1 ? (
              <motion.div key="address" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="card p-6">
                <div className="flex items-center justify-between">
                  <h2 className="flex items-center gap-2 font-display text-lg font-bold">
                    <MapPin className="h-5 w-5 text-brand-600" /> Where should we deliver?
                  </h2>
                  {!addingAddress && (
                    <button type="button" onClick={() => setAddingAddress(true)} className="btn btn-ghost btn-sm">
                      <Plus className="h-4 w-4" /> New address
                    </button>
                  )}
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {addresses.map((a) => {
                    const selected = a._id === addressId;
                    return (
                      <motion.button
                        key={a._id}
                        type="button"
                        whileTap={{ scale: 0.98 }}
                        onClick={() => setAddressId(a._id)}
                        className={cn(
                          'relative rounded-2xl border-2 p-4 text-left transition',
                          selected ? 'border-brand-500 bg-brand-50/50 shadow-md shadow-brand-500/10 dark:bg-brand-500/10' : 'border-zinc-200 hover:border-zinc-300 dark:border-white/10',
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] font-bold tracking-wide uppercase dark:bg-white/10">{a.label}</span>
                          {a.isDefault && <span className="text-[11px] font-semibold text-brand-600">Default</span>}
                        </div>
                        <p className="mt-2 font-semibold">{a.fullName}</p>
                        <p className="text-sm muted">{a.line1}{a.line2 ? `, ${a.line2}` : ''}</p>
                        <p className="text-sm muted">{a.city}, {a.state} {a.pincode}</p>
                        <p className="mt-1 text-xs muted">📞 {a.phone}</p>
                        <span className={cn('absolute top-4 right-4 flex h-5 w-5 items-center justify-center rounded-full border-2 transition', selected ? 'border-brand-600 bg-brand-600' : 'border-zinc-300 dark:border-white/20')}>
                          {selected && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                        </span>
                      </motion.button>
                    );
                  })}
                </div>

                <AnimatePresence>
                  {addingAddress && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                      <div className="mt-5 rounded-2xl border border-dashed border-brand-300 bg-brand-50/30 p-5 dark:border-brand-400/30 dark:bg-brand-500/5">
                        <p className="mb-4 font-semibold">Add a new address</p>
                        <AddressForm
                          initial={{ fullName: user.name, phone: user.phone || '', isDefault: !addresses.length }}
                          onSubmit={(payload) => addAddress.mutate(payload)}
                          onCancel={addresses.length ? () => setAddingAddress(false) : undefined}
                          saving={addAddress.isPending}
                          submitLabel="Save & deliver here"
                        />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="mt-6 flex justify-end">
                  <button type="button" disabled={!address} onClick={() => setStep(2)} className="btn btn-primary btn-lg">
                    Deliver here & continue
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.div key="review" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="space-y-4">
                <div className="card flex items-start gap-4 p-5">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
                    <MapPin className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="font-semibold">Delivering to {address?.fullName}</p>
                    <p className="muted">{address?.line1}, {address?.city}, {address?.state} {address?.pincode}</p>
                  </div>
                  <button type="button" onClick={() => setStep(1)} className="btn btn-ghost btn-sm">Change</button>
                </div>

                {groups.map((group, i) => (
                  <div key={group.vendor?._id} className="card overflow-hidden">
                    <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 bg-zinc-50/60 px-5 py-3 dark:border-white/5 dark:bg-white/[0.02]">
                      <Package className="h-4 w-4 text-brand-600" />
                      <p className="text-sm font-semibold">Package {i + 1} of {groups.length}</p>
                      <span className="text-sm muted">· Sold by</span>
                      <StoreAvatar store={group.vendor} size="h-6 w-6" rounded="rounded-md" className="text-[9px]" />
                      <span className="text-sm font-semibold">{group.vendor?.storeName}</span>
                      <span className="ml-auto flex items-center gap-1 text-xs font-semibold text-emerald-600">
                        <Truck className="h-3.5 w-3.5" /> by {deliveryEstimate(3 + i)}
                      </span>
                    </div>
                    <ul className="divide-y divide-zinc-100 dark:divide-white/5">
                      {group.items.map((item) => (
                        <li key={item.productId} className="flex items-center gap-4 px-5 py-3">
                          <img src={item.product.thumbnail} alt="" className="h-14 w-14 rounded-xl bg-zinc-50 object-contain p-1 dark:bg-white/5" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold">{item.product.title}</p>
                            <p className="text-xs muted">Qty {item.quantity} × {money(item.product.price)}</p>
                          </div>
                          <p className="font-semibold">{money(item.lineTotal)}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <aside className="lg:sticky lg:top-36 lg:self-start">
          <div className="card space-y-5 p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-bold">Order summary</h2>
              <span className="text-sm muted">{plural(summary.itemCount, 'item')}</span>
            </div>
            <div className="flex -space-x-3">
              {items.slice(0, 6).map((i) => (
                <img key={i.productId} src={i.product.thumbnail} alt="" className="h-12 w-12 rounded-xl bg-white object-contain p-1 ring-2 ring-white dark:bg-zinc-800 dark:ring-surface-dark" />
              ))}
              {items.length > 6 && <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-100 text-xs font-bold ring-2 ring-white dark:bg-white/10 dark:ring-surface-dark">+{items.length - 6}</span>}
            </div>
            <CouponBox items={items} subtotal={summary.subtotal} onApplied={setPriced} />
            <PriceBreakdown summary={summary} discount={discount} shipping={shipping} total={total} />
            {/* Stays locked on the address step; "Deliver here & continue" is the only way forward. */}
            <button
              type="button"
              onClick={placeOrder}
              disabled={placing || step !== 2}
              title={step !== 2 ? 'Confirm your delivery address first' : undefined}
              className="btn btn-accent btn-lg w-full disabled:cursor-not-allowed"
            >
              {placing ? <Spinner className="h-4 w-4" /> : <Lock className="h-4 w-4" />} Place order & pay {money(total)}
            </button>
            <p className="flex items-center justify-center gap-1.5 text-[11px] muted">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" /> 100% secure payments · Easy returns
            </p>
          </div>
        </aside>
      </div>

      <StripePaymentModal
        checkout={stripeCheckout}
        onPaid={(order) => {
          const id = stripeCheckout.order._id;
          setStripeCheckout(null);
          // The order page greets the paid order with its own "order placed" toast.
          if (order) return finish(order);
          queryClient.invalidateQueries({ queryKey: ['orders'] });
          return navigate(`/orders/${id}`);
        }}
        onClose={() => {
          const id = stripeCheckout?.order._id;
          setStripeCheckout(null);
          toast('Payment not completed. Your order is saved — you can pay from My Orders.', { icon: '🕒' });
          queryClient.invalidateQueries({ queryKey: ['orders'] });
          navigate(`/orders/${id}`);
        }}
      />
      <MockPaymentModal
        open={Boolean(mockCheckout)}
        amount={mockCheckout?.payment.amount}
        orderNumber={mockCheckout?.order.orderNumber}
        onResult={onMockResult}
        onClose={() => {
          const id = mockCheckout?.order._id;
          setMockCheckout(null);
          toast('Payment not completed. Your order is saved — you can pay from My Orders.', { icon: '🕒' });
          queryClient.invalidateQueries({ queryKey: ['orders'] });
          navigate(`/orders/${id}`);
        }}
      />
    </div>
  );
}
