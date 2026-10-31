import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Session state. The access token lives in memory only (never in localStorage, so an injected script
 * can't lift a long-lived credential); the refresh token is an httpOnly cookie the browser manages.
 * Only the profile is persisted, so the UI can render signed-in right away while the token is refreshed.
 * `blocked` ({ reason, blockedAt }) is set when the API says this account is blocked: the app then shows
 * only the blocked screen. It is persisted so a reload doesn't flash the site; the API stays the authority.
 * API calls that change it live in lib/session.js.
 */
export const useAuth = create(
  persist(
    (set) => ({
      token: null,
      user: null,
      blocked: null,
      setSession: (token, user) => set({ token, user, blocked: null }),
      setToken: (token) => set({ token }),
      setUser: (user) => set({ user }),
      clear: () => set({ token: null, user: null }),
      block: (blocked) => set({ token: null, user: null, blocked }),
      unblock: () => set({ blocked: null }),
    }),
    // v1: tokens are no longer persisted; drop any token an older version stored.
    {
      name: 'vendora-auth',
      version: 1,
      partialize: (state) => ({ user: state.user, blocked: state.blocked }),
      migrate: (stored) => ({ user: stored?.user ?? null, blocked: stored?.blocked ?? null }),
    },
  ),
);
