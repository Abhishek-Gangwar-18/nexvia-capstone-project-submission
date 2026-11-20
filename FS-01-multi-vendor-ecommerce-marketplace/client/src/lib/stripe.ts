import { loadStripe } from '@stripe/stripe-js';

const loaders = new Map();

/**
 * Stripe.ts for a publishable key, loaded once (the key comes from the API with each payment).
 * A failed load (network, blocked script, wrong key) is not cached, so the next attempt tries again.
 */
export function stripeFor(publishableKey) {
  if (!loaders.has(publishableKey)) {
    const loading = loadStripe(publishableKey).then((stripe) => {
      if (!stripe) throw new Error('Stripe could not be loaded');
      return stripe;
    });
    loading.catch(() => loaders.delete(publishableKey));
    loaders.set(publishableKey, loading);
  }
  return loaders.get(publishableKey);
}

/** Where Stripe sends the customer back after a redirect-based method (some UPI / bank flows, 3-D Secure). */
export const stripeReturnUrl = (orderId) => `${window.location.origin}/orders/${orderId}?stripe=return`;
