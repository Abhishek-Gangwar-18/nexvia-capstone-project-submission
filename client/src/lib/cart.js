import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api, errorMessage } from './api';
import { useAuth } from '../store/auth';
import { useCartStore } from '../store/cart';

const GUEST_SHIPPING = { fee: 49, threshold: 999 };

function summarizeGuest(items) {
  const buyable = items.filter((i) => i.inStock !== false);
  const subtotal = buyable.reduce((sum, i) => sum + i.product.price * i.quantity, 0);
  const mrpTotal = buyable.reduce((sum, i) => sum + (i.product.mrp || i.product.price) * i.quantity, 0);
  const shipping = subtotal <= 0 || subtotal >= GUEST_SHIPPING.threshold ? 0 : GUEST_SHIPPING.fee;
  return {
    itemCount: buyable.reduce((sum, i) => sum + i.quantity, 0),
    subtotal,
    mrpTotal,
    savings: mrpTotal - subtotal,
    shipping,
    total: subtotal + shipping,
    freeShippingThreshold: GUEST_SHIPPING.threshold,
    shippingFee: GUEST_SHIPPING.fee,
  };
}

/** One cart API for the UI: the Redis-backed server cart for customers, the browser cart for guests. */
export function useCart() {
  const user = useAuth((s) => s.user);
  const isCustomer = user?.role === 'customer';
  const guestItems = useCartStore((s) => s.guestItems);
  const query = useQuery({
    queryKey: ['cart'],
    queryFn: () => api.get('/cart').then((r) => r.data),
    enabled: isCustomer,
  });

  if (isCustomer) {
    const items = (query.data?.items || []).map((i) => ({ ...i, lineTotal: i.lineTotal ?? i.product.price * i.quantity }));
    return { items, summary: query.data?.summary || summarizeGuest([]), isLoading: query.isLoading, isGuest: false, canShop: true };
  }
  const items = guestItems.map((i) => ({ ...i, lineTotal: i.product.price * i.quantity }));
  return { items, summary: summarizeGuest(guestItems), isLoading: false, isGuest: true, canShop: !user };
}

export function useCartActions() {
  const queryClient = useQueryClient();
  const user = useAuth((s) => s.user);
  const store = useCartStore();
  const isCustomer = user?.role === 'customer';
  const setCart = (data) => queryClient.setQueryData(['cart'], data);

  const guard = () => {
    if (user && !isCustomer) {
      toast.error('Seller and admin accounts can’t shop. Sign in with a customer account.');
      return false;
    }
    return true;
  };

  return {
    /** Adds a product; returns true on success. */
    async add(product, quantity = 1, { silent = false, openDrawer = true } = {}) {
      if (!guard()) return false;
      try {
        if (isCustomer) setCart((await api.post('/cart/items', { productId: product._id, quantity })).data);
        else store.addGuest(product, quantity);
        if (!silent) toast.success('Added to cart');
        if (openDrawer) store.openDrawer();
        return true;
      } catch (error) {
        toast.error(errorMessage(error));
        return false;
      }
    },
    async update(productId, quantity) {
      try {
        if (isCustomer) setCart((await api.patch(`/cart/items/${productId}`, { quantity })).data);
        else store.updateGuest(productId, quantity);
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    async remove(productId) {
      try {
        if (isCustomer) setCart((await api.delete(`/cart/items/${productId}`)).data);
        else store.updateGuest(productId, 0);
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
  };
}
