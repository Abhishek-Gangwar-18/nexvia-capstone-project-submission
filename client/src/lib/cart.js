import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from './api';
import { useAuth } from '../store/auth';
import { useCartStore } from '../store/cart';

const EMPTY_SUMMARY = { itemCount: 0, subtotal: 0, mrpTotal: 0, savings: 0, shipping: 0, total: 0, freeShippingThreshold: 0, shippingFee: 0 };

/** The Redis-backed server cart. Only signed-in customers have one. */
export function useCart() {
  const user = useAuth((s) => s.user);
  const isCustomer = user?.role === 'customer';
  const query = useQuery({
    queryKey: ['cart'],
    queryFn: () => api.get('/cart').then((r) => r.data),
    enabled: isCustomer,
  });
  const items = isCustomer ? query.data?.items || [] : [];
  return { items, summary: query.data?.summary || EMPTY_SUMMARY, isLoading: isCustomer && query.isLoading, isGuest: !user, canShop: !user || isCustomer };
}

export function useCartActions() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuth((s) => s.user);
  const openDrawer = useCartStore((s) => s.openDrawer);
  const setCart = (data) => queryClient.setQueryData(['cart'], data);
  const currentQuantity = (productId) => queryClient.getQueryData(['cart'])?.items?.find((i) => i.productId === productId)?.quantity || 0;

  const guard = () => {
    if (!user) {
      toast('Sign in to add items to your cart');
      navigate('/login', { state: { from: location } });
      return false;
    }
    if (user.role !== 'customer') {
      toast.error('Seller and admin accounts can’t shop. Sign in with a customer account.');
      return false;
    }
    return true;
  };
  // POST /cart/items takes the line's new total quantity.
  const setQuantity = async (productId, quantity) => setCart((await api.post('/cart/items', { productId, quantity })).data);

  return {
    /** Adds `quantity` on top of what is already in the cart; returns true on success. */
    async add(product, quantity = 1, { silent = false, openDrawer: open = true } = {}) {
      if (!guard()) return false;
      try {
        await setQuantity(product._id, currentQuantity(product._id) + quantity);
        if (!silent) toast.success('Added to cart');
        if (open) openDrawer();
        return true;
      } catch (error) {
        toast.error(errorMessage(error));
        return false;
      }
    },
    async update(productId, quantity) {
      try {
        if (quantity <= 0) setCart((await api.delete(`/cart/items/${productId}`)).data);
        else await setQuantity(productId, quantity);
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    async remove(productId) {
      try {
        setCart((await api.delete(`/cart/items/${productId}`)).data);
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
  };
}
