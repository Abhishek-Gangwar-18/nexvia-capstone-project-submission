import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, CreditCard, Download, MapPin, MessageSquarePlus, PartyPopper, Receipt, Store, Truck, X, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, downloadFile, errorMessage } from '../lib/api';
import { openRazorpay } from '../lib/razorpay';
import { formatDateTime, money } from '../lib/format';
import { NEXT_ACTION } from '../lib/status';
import OrderTimeline from '../components/orders/OrderTimeline';
import StatusBadge from '../components/ui/StatusBadge';
import { ConfirmDialog } from '../components/ui/Modal';
import { ErrorState, PageLoader, Spinner } from '../components/ui/Feedback';
import MockPaymentModal from '../components/checkout/MockPaymentModal';

function SuccessBanner({ order, onClose }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -20, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10 }}
      className="relative mb-6 overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-500 to-teal-600 p-6 text-white shadow-xl shadow-emerald-600/20"
    >
      {Array.from({ length: 18 }, (_, i) => (
        <motion.span
          key={i}
          className="absolute h-2 w-2 rounded-sm"
          style={{ left: `${(i * 37) % 100}%`, top: -10, background: ['#fde68a', '#fbcfe8', '#c7d2fe', '#ffffff'][i % 4] }}
          animate={{ y: [0, 160], rotate: [0, 360], opacity: [1, 0] }}
          transition={{ duration: 1.8 + (i % 5) * 0.3, delay: (i % 6) * 0.1, ease: 'easeIn' }}
        />
      ))}
      <button type="button" onClick={onClose} className="absolute top-3 right-3 rounded-lg p-1.5 text-white/80 hover:bg-white/10" aria-label="Dismiss">
        <X className="h-4 w-4" />
      </button>
      <div className="relative flex items-center gap-4">
        <motion.div initial={{ rotate: -20, scale: 0 }} animate={{ rotate: 0, scale: 1 }} transition={{ type: 'spring', delay: 0.2 }} className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/20">
          <PartyPopper className="h-7 w-7" />
        </motion.div>
        <div>
          <p className="font-display text-2xl font-bold">Order placed successfully!</p>
          <p className="text-sm text-emerald-50">
            Thank you! {order.packages.length > 1 ? `Your ${order.packages.length} packages are` : 'Your package is'} being prepared by the seller{order.packages.length > 1 ? 's' : ''}.
          </p>
        </div>
      </div>
    </motion.div>
  );
}

function AdminPackageActions({ order, pkg, onDone }) {
  const [busy, setBusy] = useState(false);
  const next = NEXT_ACTION[pkg.status];
  const run = async (status) => {
    setBusy(true);
    try {
      await api.patch(`/admin/orders/${order._id}/packages/${pkg._id}`, { status });
      toast.success(`Package marked ${status}`);
      onDone();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  if (!next && pkg.status !== 'placed') return null;
  return (
    <div className="flex flex-wrap gap-2 border-t border-zinc-100 px-5 py-3 dark:border-white/5">
      {next && (
        <button type="button" disabled={busy} onClick={() => run(next.status)} className="btn btn-primary btn-sm">
          {busy && <Spinner className="h-3.5 w-3.5" />} {next.label}
        </button>
      )}
      {['placed', 'packed'].includes(pkg.status) && (
        <button type="button" disabled={busy} onClick={() => run('cancelled')} className="btn btn-secondary btn-sm text-rose-600">
          Cancel package
        </button>
      )}
    </div>
  );
}

export default function OrderDetail({ admin = false }) {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [paying, setPaying] = useState(false);
  const [mockCheckout, setMockCheckout] = useState(null);
  const showSuccess = params.get('placed') === '1';

  const { data: order, isLoading, error, refetch } = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get(`/orders/${id}`).then((r) => r.data.order),
  });

  if (isLoading) return <PageLoader />;
  if (error) {
    return (
      <div className="container-page py-16">
        <ErrorState error={error} onRetry={refetch} />
      </div>
    );
  }

  const refresh = () => {
    refetch();
    queryClient.invalidateQueries({ queryKey: ['orders'] });
  };
  const live = order.packages.filter((p) => p.status !== 'cancelled');
  const canCancel = !admin && order.status !== 'cancelled' && (order.payment.status === 'pending' || (live.length > 0 && live.every((p) => ['placed', 'packed'].includes(p.status))));
  const canInvoice = ['paid', 'refunded'].includes(order.payment.status);

  const invoice = async () => {
    setDownloading(true);
    try {
      await downloadFile(`/orders/${order._id}/invoice`, `invoice-${order.orderNumber}.pdf`);
      toast.success('Invoice downloaded');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  const cancel = async () => {
    setCancelling(true);
    try {
      await api.post(`/orders/${order._id}/cancel`, { reason: 'Changed my mind' });
      toast.success(order.payment.status === 'paid' ? 'Order cancelled. Refund initiated.' : 'Order cancelled');
      setConfirmCancel(false);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCancelling(false);
    }
  };

  const pay = async () => {
    setPaying(true);
    try {
      const { data } = await api.get(`/orders/${order._id}/payment`);
      if (data.payment.provider === 'mock') {
        setMockCheckout(data);
        return;
      }
      const response = await openRazorpay({ ...data, onFailure: (message) => toast.error(message) });
      await api.post(`/orders/${order._id}/verify`, response);
      toast.success('Payment successful!');
      queryClient.invalidateQueries({ queryKey: ['cart'] });
      refresh();
    } catch (err) {
      if (!err?.dismissed) toast.error(errorMessage(err));
    } finally {
      setPaying(false);
    }
  };

  const back = admin ? '/admin/orders' : '/orders';

  return (
    <div className={admin ? '' : 'container-page py-8'}>
      <AnimatePresence>
        {showSuccess && order.payment.status === 'paid' && <SuccessBanner order={order} onClose={() => setParams({})} />}
      </AnimatePresence>

      <Link to={back} className="inline-flex items-center gap-1 text-sm font-semibold muted hover:text-brand-600">
        <ChevronLeft className="h-4 w-4" /> {admin ? 'All orders' : 'My orders'}
      </Link>

      <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Order #{order.orderNumber}</h1>
            <StatusBadge status={order.status} pulse={['placed', 'processing', 'shipped'].includes(order.status)} />
          </div>
          <p className="mt-1 text-sm muted">
            Placed {formatDateTime(order.createdAt)}
            {admin && order.customer && ` · ${order.customer.name} (${order.customer.email})`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {order.status === 'pending_payment' && !admin && (
            <button type="button" onClick={pay} disabled={paying} className="btn btn-accent">
              {paying ? <Spinner className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />} Complete payment
            </button>
          )}
          {canInvoice && (
            <button type="button" onClick={invoice} disabled={downloading} className="btn btn-secondary">
              {downloading ? <Spinner className="h-4 w-4" /> : <Download className="h-4 w-4" />} Invoice (PDF)
            </button>
          )}
          {canCancel && (
            <button type="button" onClick={() => setConfirmCancel(true)} className="btn btn-secondary text-rose-600">
              <XCircle className="h-4 w-4" /> Cancel order
            </button>
          )}
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {order.packages.map((pkg, i) => (
            <motion.div key={pkg._id} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }} className="card overflow-hidden">
              <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 bg-zinc-50/60 px-5 py-3 dark:border-white/5 dark:bg-white/[0.02]">
                <Store className="h-4 w-4 text-brand-600" />
                <p className="text-sm">
                  Package {i + 1} · <span className="font-semibold">{pkg.storeName}</span>
                </p>
                <StatusBadge status={pkg.status} className="ml-auto" />
              </div>
              <div className="px-5 py-6">
                <OrderTimeline pkg={pkg} />
                {pkg.trackingId && (
                  <p className="mt-5 flex items-center justify-center gap-2 text-xs muted">
                    <Truck className="h-3.5 w-3.5" /> Tracking ID <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-200">{pkg.trackingId}</span>
                  </p>
                )}
              </div>
              <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-white/5 dark:border-white/5">
                {pkg.items.map((item) => (
                  <li key={item.product} className="flex items-center gap-4 px-5 py-3">
                    <Link to={`/product/${item.slug}`} className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-zinc-50 dark:bg-white/5">
                      <img src={item.image} alt="" className="h-full w-full object-contain p-1" />
                    </Link>
                    <div className="min-w-0 flex-1">
                      <Link to={`/product/${item.slug}`} className="line-clamp-1 text-sm font-semibold hover:text-brand-600">{item.title}</Link>
                      <p className="text-xs muted">Qty {item.quantity} × {money(item.price)}</p>
                      {!admin && pkg.status === 'delivered' && (
                        <button type="button" onClick={() => navigate(`/product/${item.slug}#reviews`)} className="mt-1 flex items-center gap-1 text-xs font-semibold text-brand-600 dark:text-brand-300">
                          <MessageSquarePlus className="h-3.5 w-3.5" /> Rate & review
                        </button>
                      )}
                    </div>
                    <p className="font-semibold">{money(item.total)}</p>
                  </li>
                ))}
              </ul>
              {admin && (
                <div className="grid grid-cols-3 gap-2 border-t border-zinc-100 bg-zinc-50/50 px-5 py-3 text-xs dark:border-white/5 dark:bg-white/[0.02]">
                  <div><p className="muted">Package total</p><p className="font-semibold">{money(pkg.total)}</p></div>
                  <div><p className="muted">Commission ({pkg.commissionRate}%)</p><p className="font-semibold text-brand-600">{money(pkg.commission)}</p></div>
                  <div><p className="muted">Vendor payout · {pkg.payout?.status?.replace('_', ' ')}</p><p className="font-semibold">{money(pkg.vendorEarning)}</p></div>
                </div>
              )}
              {admin && <AdminPackageActions order={order} pkg={pkg} onDone={refresh} />}
            </motion.div>
          ))}
        </div>

        <aside className="space-y-4">
          <div className="card p-5">
            <h3 className="flex items-center gap-2 font-semibold"><MapPin className="h-4 w-4 text-brand-600" /> Shipping address</h3>
            <div className="mt-3 text-sm">
              <p className="font-semibold">{order.shippingAddress.fullName}</p>
              <p className="muted">{order.shippingAddress.line1}</p>
              {order.shippingAddress.line2 && <p className="muted">{order.shippingAddress.line2}</p>}
              <p className="muted">{order.shippingAddress.city}, {order.shippingAddress.state} {order.shippingAddress.pincode}</p>
              <p className="mt-1 text-xs muted">📞 {order.shippingAddress.phone}</p>
            </div>
          </div>
          <div className="card p-5">
            <h3 className="flex items-center gap-2 font-semibold"><Receipt className="h-4 w-4 text-brand-600" /> Payment</h3>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between"><span className="muted">Status</span><StatusBadge status={order.payment.status} /></div>
              <div className="flex justify-between"><span className="muted">Gateway</span><span className="font-semibold">{order.payment.provider === 'razorpay' ? 'Razorpay' : 'Test gateway'}</span></div>
              {order.payment.method && <div className="flex justify-between"><span className="muted">Method</span><span className="font-semibold uppercase">{order.payment.method}</span></div>}
              {order.payment.paymentId && <div className="flex justify-between gap-4"><span className="muted">Payment ID</span><span className="truncate font-mono text-xs">{order.payment.paymentId}</span></div>}
            </div>
            <div className="mt-4 space-y-2 border-t border-dashed border-zinc-200 pt-4 text-sm dark:border-white/10">
              <div className="flex justify-between"><span className="muted">Subtotal</span><span>{money(order.pricing.subtotal)}</span></div>
              {order.pricing.discount > 0 && (
                <div className="flex justify-between text-emerald-600"><span>Coupon {order.coupon?.code}</span><span>−{money(order.pricing.discount)}</span></div>
              )}
              <div className="flex justify-between"><span className="muted">Delivery</span><span>{order.pricing.shipping ? money(order.pricing.shipping) : 'FREE'}</span></div>
              <div className="flex justify-between pt-1 text-base font-bold"><span>Total</span><span className="font-display">{money(order.pricing.total)}</span></div>
            </div>
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={cancel}
        loading={cancelling}
        danger
        title="Cancel this order?"
        description={order.payment.status === 'paid' ? `All packages will be cancelled and ${money(order.pricing.total)} refunded to your original payment method.` : 'This unpaid order will be cancelled.'}
        confirmLabel="Yes, cancel order"
      />

      <MockPaymentModal
        open={Boolean(mockCheckout)}
        amount={mockCheckout?.payment.amount}
        orderNumber={mockCheckout?.order.orderNumber}
        onClose={() => setMockCheckout(null)}
        onResult={async (outcome) => {
          try {
            await api.post(`/orders/${order._id}/verify`, { outcome });
            setTimeout(() => {
              setMockCheckout(null);
              queryClient.invalidateQueries({ queryKey: ['cart'] });
              setParams({ placed: '1' });
              refresh();
            }, 1000);
            return true;
          } catch (err) {
            toast.error(errorMessage(err));
            return false;
          }
        }}
      />
    </div>
  );
}
