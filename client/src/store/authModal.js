import { create } from 'zustand';

/** Which auth modal is open ('login' | 'register' | null), where to go after signing in, and the sign-up role. */
export const useAuthModal = create((set) => ({
  view: null,
  from: null,
  role: 'customer',
  open: (view = 'login', { from = null, role = 'customer' } = {}) => set({ view, from, role }),
  switchTo: (view) => set({ view }),
  close: () => set({ view: null, from: null, role: 'customer' }),
}));
