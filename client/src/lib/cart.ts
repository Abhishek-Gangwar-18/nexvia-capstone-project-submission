import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { API_URL, api, errorMessage, refreshAccessToken } from './api';
import { useAuth } from '../store/auth';
import { useCartStore } from '../store/cart';
import { useAuthModal } from '../store/authModal';

/** The API reports lines it dropped (deleted, hidden, store suspended) once: tell the customer. */
function notifyRemoved(data) {
  if (data?.removed?.length) {
    toast(`Removed from your cart (no longer available): ${data.removed.map((r) => r.title).join(', ')}`, { icon: '⚠️', id: 'cart-removed', duration: 6000 });
  }
  return data;
}

/**
 * Quantity writes for one product go out one at a time, and only the latest wanted value is sent next.
 * Otherwise fast clicks (2, 3) could reach the server in the wrong order and leave the cart at 2.
 */
interface QueuedWrite {
  next: number | undefined;
  done?: Promise<any>;
}
const writes = new Map<string, QueuedWrite>();
function queueWrite(productId, quantity, send) {
  const running = writes.get(productId);
  if (running) {
    running.next = quantity;
    return running.done;
  }
  const entry: QueuedWrite = { next: undefined };
  entry.done = (async () => {
    let qty = quantity;
    try {
      for (;;) {
        await send(qty);
        if (entry.next === undefined) break;
        qty = entry.next;
        entry.next = undefined;
      }
    } finally {
      writes.delete(productId);
    }
  })();
  writes.set(productId, entry);
  return entry.done;
}

const EMPTY_SUMMARY = { itemCount: 0, subtotal: 0, mrpTotal: 0, savings: 0, shipping: 0, total: 0, freeShippingThreshold: 0, shippingFee: 0 };

/** The Redis-backed server cart. Only signed-in customers have one. */
export function useCart() {
  const user = useAuth((s) => s.user);
  const isCustomer = user?.role === 'customer';
  const query = useQuery({
    queryKey: ['cart'],
    queryFn: () => api.get('/cart').then((r) => notifyRemoved(r.data)),
    enabled: isCustomer,
    // Stock and prices change under an open cart: re-check whenever the cart is shown again or the tab
    // regains focus. Instant pushes come from useCartLiveUpdates below.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const items = isCustomer ? query.data?.items || [] : [];
  return { items, summary: query.data?.summary || EMPTY_SUMMARY, isLoading: isCustomer && query.isLoading, isGuest: !user, canShop: !user || isCustomer };
}

export function useCartActions() {
  const queryClient = useQueryClient();
  const user = useAuth((s) => s.user);
  const setCart = (data) => queryClient.setQueryData(['cart'], notifyRemoved(data));
  // Show the new quantity at once (so the next click builds on it); the server's answer replaces it.
  const showQuantity = (productId, quantity) =>
    queryClient.setQueryData(['cart'], (cart: any) =>
      cart && { ...cart, items: cart.items.map((i) => (i.productId === productId ? { ...i, quantity, lineTotal: i.product.price * quantity } : i)) },
    );
  const currentQuantity = (productId) => queryClient.getQueryData<any>(['cart'])?.items?.find((i) => i.productId === productId)?.quantity || 0;

  const guard = () => {
    if (!user) {
      toast('Sign in to add items to your cart');
      useAuthModal.getState().open('login');
      return false;
    }
    if (user.role !== 'customer') {
      toast.error('Seller and admin accounts can’t shop. Sign in with a customer account.');
      return false;
    }
    return true;
  };
  // POST /cart/items takes the line's new total quantity; 0 removes the line. Writes per product are queued.
  const send = (productId) => async (quantity) =>
    setCart((quantity <= 0 ? await api.delete(`/cart/items/${productId}`) : await api.post('/cart/items', { productId, quantity })).data);
  const setQuantity = (productId, quantity) => {
    if (quantity > 0) showQuantity(productId, quantity);
    return queueWrite(productId, quantity, send(productId));
  };

  return {
    /** Adds `quantity` on top of what is already in the cart; returns true on success. */
    /** Never opens the cart drawer: the drawer opens only from the navbar cart button. */
    async add(product, quantity = 1, { silent = false } = {}) {
      if (!guard()) return false;
      try {
        await setQuantity(product._id, currentQuantity(product._id) + quantity);
        if (!silent) toast.success('Added to cart');
        return true;
      } catch (error) {
        toast.error(errorMessage(error));
        return false;
      }
    },
    async update(productId, quantity) {
      try {
        await setQuantity(productId, quantity);
      } catch (error) {
        toast.error(errorMessage(error));
        queryClient.invalidateQueries({ queryKey: ['cart'] }); // undo the optimistic quantity
      }
    },
    async remove(productId) {
      try {
        await setQuantity(productId, 0);
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
  };
}

/**
 * Keeps the open cart in sync with the server: listens to GET /cart/events (Server-Sent Events, read with
 * fetch so the Bearer token can be sent) and refetches the cart the moment a product in it changes stock,
 * price or availability. Reconnects after drops, refreshing the access token when it has expired.
 */
export function useCartLiveUpdates() {
  const queryClient = useQueryClient();
  const isCustomer = useAuth((s) => s.user?.role === 'customer');

  useEffect(() => {
    if (!isCustomer) return undefined;
    let stopped = false;
    let controller = null;
    let retry = null;

    const connect = async (attempt = 0) => {
      controller = new AbortController();
      try {
        let token = useAuth.getState().token || (await refreshAccessToken().catch(() => null));
        let res = await fetch(`${API_URL}/cart/events`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'include', signal: controller.signal });
        if (res.status === 401) {
          token = await refreshAccessToken();
          res = await fetch(`${API_URL}/cart/events`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'include', signal: controller.signal });
        }
        if (!res.ok || !res.body) throw new Error(`cart events ${res.status}`);
        attempt = 0;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          const events = buffer.split('\n\n');
          buffer = events.pop();
          const changed = events.filter((e) => e.includes('event: cart')).map((e) => JSON.parse(e.split('data: ')[1] || '{}').productId);
          if (events.some((e) => e.includes('event: coupon'))) {
            // Offer lists (cart, checkout) drop switched-off coupons; an applied one is re-checked.
            queryClient.invalidateQueries({ queryKey: ['coupons'] });
            if (useCartStore.getState().couponCode) useCartStore.getState().recheckCoupon();
          }
          if (changed.length) {
            await queryClient.invalidateQueries({ queryKey: ['cart'] });
            // An open product page of that product shows its stock too ("only 2 left"): refresh it as well.
            changed.forEach((id) => id && queryClient.invalidateQueries({ queryKey: ['product', id] }));
            toast('Stock or price changed for an item in your cart', { icon: '🔄', id: 'cart-live' });
          }
        }
      } catch {
        /* dropped or aborted: reconnect below */
      }
      if (!stopped) retry = setTimeout(() => connect(attempt + 1), Math.min(30_000, 2000 * 2 ** attempt));
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      controller?.abort();
    };
  }, [isCustomer, queryClient]);
}
