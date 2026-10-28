import { api } from './api';
import { queryClient } from './queryClient';
import { useAuth } from '../store/auth';
import { useCartStore } from '../store/cart';

async function establish({ token, user }) {
  queryClient.clear();
  useAuth.getState().setSession(token, user);

  // Carry the guest cart over into the customer's server cart.
  const guest = useCartStore.getState().guestItems;
  if (user.role === 'customer' && guest.length) {
    try {
      const { data } = await api.post('/cart/merge', {
        items: guest.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      });
      queryClient.setQueryData(['cart'], data);
      useCartStore.getState().clearGuest();
    } catch {
      /* merge is best-effort; the guest cart stays in the browser */
    }
  }
  return user;
}

export async function login(credentials) {
  const { data } = await api.post('/auth/login', credentials);
  return establish(data);
}

export async function register(payload) {
  const { data } = await api.post('/auth/register', payload);
  return establish(data);
}

export async function logout() {
  try {
    await api.post('/auth/logout');
  } catch {
    /* token may already be invalid — clearing locally is enough */
  }
  useAuth.getState().clear();
  queryClient.clear();
}

export async function refreshMe() {
  const { data } = await api.get('/auth/me');
  useAuth.getState().setUser(data.user);
  return data.user;
}

/** Where each role lands after signing in. */
export function homeFor(user) {
  if (!user) return '/';
  if (user.role === 'admin') return '/admin';
  if (user.role === 'vendor') return user.vendor?.status === 'approved' ? '/vendor' : '/vendor/onboarding';
  return '/';
}
