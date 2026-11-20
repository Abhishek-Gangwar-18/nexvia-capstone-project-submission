import { create } from 'zustand';
import type { Role } from '../types';

type AuthView = 'login' | 'register';

interface AuthModalState {
  view: AuthView | null;
  from: string | null;
  role: Role;
  open: (view?: AuthView, options?: { from?: string | null; role?: Role }) => void;
  switchTo: (view: AuthView) => void;
  close: () => void;
}

/** Which auth modal is open ('login' | 'register' | null), where to go after signing in, and the sign-up role. */
export const useAuthModal = create<AuthModalState>()((set) => ({
  view: null,
  from: null,
  role: 'customer',
  open: (view = 'login', { from = null, role = 'customer' } = {}) => set({ view, from, role }),
  switchTo: (view) => set({ view }),
  close: () => set({ view: null, from: null, role: 'customer' }),
}));
