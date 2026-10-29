import { loadStripe } from '@stripe/stripe-js';

const loaders = new Map();

/** Stripe.js for a publishable key, loaded once (the key comes from the API with each payment). */
export function stripeFor(publishableKey) {
  if (!loaders.has(publishableKey)) loaders.set(publishableKey, loadStripe(publishableKey));
  return loaders.get(publishableKey);
}

/** Where Stripe sends the customer back after a redirect-based method (some UPI / bank flows, 3-D Secure). */
export const stripeReturnUrl = (orderId) => `${window.location.origin}/orders/${orderId}?stripe=return`;
