import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Session state. API calls that change it live in lib/session.js. */
export const useAuth = create(
  persist(
    (set) => ({
      token: null,
      user: null,
      setSession: (token, user) => set({ token, user }),
      setUser: (user) => set({ user }),
      clear: () => set({ token: null, user: null }),
    }),
    { name: 'vendora-auth' },
  ),
);
