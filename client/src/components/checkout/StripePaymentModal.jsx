import { useEffect, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { Lock, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { money } from '../../lib/format';
import { stripeFor, stripeReturnUrl } from '../../lib/stripe';
import { useTheme } from '../../store/theme';
import { Modal } from '../ui/Modal';
import { Spinner } from '../ui/Feedback';

function PaymentForm({ checkout, onPaid }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const orderId = checkout.order._id;

  const pay = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setError('');
    // Redirect only for methods that need it; cards and most wallets finish here.
    const { error: failure, paymentIntent } = await stripe.confirmPayment({ elements, redirect: 'if_required', confirmParams: { return_url: stripeReturnUrl(orderId) } });
    if (failure) {
      setError(failure.message || 'Payment failed');
      setBusy(false);
      return;
    }
    try {
      // The server checks the payment with Stripe before the order is marked paid.
      const { data } = await api.post(`/orders/${orderId}/verify`, { paymentIntentId: paymentIntent.id });
      onPaid(data.order);
    } catch (err) {
      if (paymentIntent?.status === 'processing') {
        toast('Your payment is processing. We will confirm the order as soon as the bank does.', { icon: '🕒' });
        onPaid(null);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={pay} className="space-y-4">
      {!ready && (
        <div className="flex items-center justify-center gap-2 py-10 text-sm muted">
          <Spinner className="h-4 w-4" /> Loading secure payment form…
        </div>
      )}
      <PaymentElement
        options={{ layout: 'tabs' }}
        onReady={() => setReady(true)}
        onLoadError={({ error: loadError }) => {
          setReady(true);
          setError(loadError?.message || 'The payment form could not be loaded. Close this window and try again.');
        }}
      />
      {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>}
      <button type="submit" disabled={!stripe || !ready || busy} className="btn btn-accent btn-lg w-full">
        {busy ? <Spinner className="h-4 w-4" /> : <Lock className="h-4 w-4" />} Pay {money(checkout.payment.amount / 100)}
      </button>
      <p className="flex items-center justify-center gap-1.5 text-[11px] muted">
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" /> Card details go straight to Stripe and never reach Vendora
      </p>
    </form>
  );
}

/**
 * Stripe Payment Element for one order. `checkout` is the API response of POST /orders/checkout
 * (or GET /orders/:id/payment): { order, payment: { publishableKey, clientSecret, amount } }.
 * onPaid(order) runs after the server confirmed the payment; onPaid(null) when it is still processing.
 */
export default function StripePaymentModal({ checkout, onPaid, onClose }) {
  const dark = useTheme((s) => s.theme === 'dark');
  const open = Boolean(checkout?.payment?.clientSecret);
  const publishableKey = checkout?.payment?.publishableKey;
  const [loaded, setLoaded] = useState({ key: null, stripe: null, error: '' });

  // Load Stripe.js first, so a failure shows a message instead of an empty window.
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    if (!publishableKey) {
      setLoaded({ key: null, stripe: null, error: 'Payments are not configured on the server (missing Stripe publishable key).' });
      return undefined;
    }
    setLoaded({ key: publishableKey, stripe: null, error: '' });
    stripeFor(publishableKey)
      .then((stripe) => live && setLoaded({ key: publishableKey, stripe, error: '' }))
      .catch((err) => live && setLoaded({ key: publishableKey, stripe: null, error: err?.message || 'Stripe could not be loaded. Check your connection or ad blocker and try again.' }));
    return () => {
      live = false;
    };
  }, [open, publishableKey]);

  const stripe = loaded.key === publishableKey ? loaded.stripe : null;
  return (
    <Modal open={open} onClose={onClose} title="Pay securely" description={checkout ? `Order ${checkout.order.orderNumber}` : ''} size="md">
      {open && loaded.error && (
        <div className="space-y-3">
          <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{loaded.error}</p>
          <p className="text-xs muted">Your order is saved. You can pay later from My Orders.</p>
        </div>
      )}
      {open && !loaded.error && !stripe && (
        <div className="flex items-center justify-center gap-2 py-10 text-sm muted">
          <Spinner className="h-4 w-4" /> Connecting to Stripe…
        </div>
      )}
      {open && stripe && (
        <Elements
          key={checkout.payment.clientSecret}
          stripe={stripe}
          options={{ clientSecret: checkout.payment.clientSecret, appearance: { theme: dark ? 'night' : 'stripe', variables: { colorPrimary: '#6236f1', borderRadius: '12px' } } }}
        >
          <PaymentForm checkout={checkout} onPaid={onPaid} />
        </Elements>
      )}
    </Modal>
  );
}
