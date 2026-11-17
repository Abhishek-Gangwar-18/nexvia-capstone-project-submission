import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api, errorMessage } from './api';
import { useAuth } from '../store/auth';

export function useDebounce(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Closes popovers when clicking outside of the referenced element. */
export function useClickOutside(onOutside) {
  const ref = useRef(null);
  useEffect(() => {
    const handler = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onOutside();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onOutside]);
  return ref;
}

export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data.categories),
    staleTime: 10 * 60 * 1000,
  });
}

export function useCategoryName() {
  const { data } = useCategories();
  return (id) => data?.find((c) => c._id === String(id))?.name || '';
}

/** Wishlist ids live on the user profile; toggling updates the cached profile optimistically. */
export function useWishlist() {
  const user = useAuth((s) => s.user);
  const setUser = useAuth((s) => s.setUser);
  const queryClient = useQueryClient();
  const ids = new Set(user?.wishlist || []);

  const mutation = useMutation({
    mutationFn: (productId: string) =>
      (ids.has(productId) ? api.delete(`/auth/me/wishlist/${productId}`) : api.put(`/auth/me/wishlist/${productId}`)).then((r) => r.data),
    onSuccess: (data) => {
      setUser({ ...useAuth.getState().user, wishlist: data.wishlist });
      queryClient.invalidateQueries({ queryKey: ['wishlist'] });
      toast.success(data.wishlisted ? 'Saved to wishlist' : 'Removed from wishlist');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return {
    has: (id) => ids.has(id),
    canUse: user?.role === 'customer',
    isLoggedIn: Boolean(user),
    toggle: (id) => mutation.mutate(id),
  };
}

const RECENT_KEY = 'vendora-recently-viewed';

export function readRecentlyViewed() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    return [];
  }
}

export function rememberProduct(card) {
  try {
    const list = readRecentlyViewed().filter((p) => p._id !== card._id);
    localStorage.setItem(RECENT_KEY, JSON.stringify([card, ...list].slice(0, 12)));
  } catch {
    /* storage may be unavailable */
  }
}

/** Ticks every second; used for deal countdowns. */
export function useNow(interval = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}
