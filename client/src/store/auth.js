import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Session state. The access token lives in memory only (never in localStorage, so an injected script
 * can't lift a long-lived credential); the refresh token is an httpOnly cookie the browser manages.
 * Only the profile is persisted, so the UI can render signed-in right away while the token is refreshed.
 * API calls that change it live in lib/session.js.
 */
export const useAuth = create(
  persist(
    (set) => ({
      token: null,
      user: null,
      setSession: (token, user) => set({ token, user }),
      setToken: (token) => set({ token }),
      setUser: (user) => set({ user }),
      clear: () => set({ token: null, user: null }),
    }),
    // v1: tokens are no longer persisted; drop any token an older version stored.
    { name: 'vendora-auth', version: 1, partialize: (state) => ({ user: state.user }), migrate: (stored) => ({ user: stored?.user ?? null }) },
  ),
);
