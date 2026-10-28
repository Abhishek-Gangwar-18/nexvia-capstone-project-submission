let loader;

/** Loads Razorpay Checkout once. */
export function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve(true);
  if (!loader) {
    loader = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = () => resolve(true);
      script.onerror = () => {
        loader = null;
        resolve(false);
      };
      document.body.appendChild(script);
    });
  }
  return loader;
}

/**
 * Opens Razorpay Checkout and resolves with the payment response, or rejects with { dismissed: true }.
 * A failed attempt keeps the modal open so the customer can retry; `onFailure` is told about it.
 */
export async function openRazorpay({ payment, order, prefill, onFailure }) {
  const ready = await loadRazorpay();
  if (!ready) throw new Error('Could not load Razorpay Checkout. Check your internet connection.');
  return new Promise((resolve, reject) => {
    const checkout = new window.Razorpay({
      key: payment.keyId,
      amount: payment.amount,
      currency: payment.currency,
      order_id: payment.gatewayOrderId,
      name: 'Vendora',
      description: `Order ${order.orderNumber}`,
      prefill,
      theme: { color: '#6236f1' },
      handler: (response) => resolve(response),
      modal: { ondismiss: () => reject({ dismissed: true }) },
    });
    checkout.on('payment.failed', (res) => onFailure?.(res.error?.description || 'Payment failed'));
    checkout.open();
  });
}
