import { create } from "zustand";
import type { Me } from "@/types";

/**
 * Authentication lives in memory only. The access token is never persisted; the refresh token is an httpOnly
 * cookie the page can't read (see lib/session.ts and backend apps/accounts/cookie_auth.py). On every page load
 * the session is restored from that cookie, so the status starts as "restoring", not "anonymous".
 */
export type AuthStatus = "restoring" | "authenticated" | "anonymous" | "error" | "rate_limited";

interface AuthState {
  status: AuthStatus;
  access: string | null;
  user: Me | null;
  /** While status is "rate_limited": seconds the server asked us to wait (Retry-After). */
  retryAfter: number | null;
  signIn: (data: { access: string; user: Me }) => void;
  setAccess: (access: string) => void;
  setUser: (user: Me) => void;
  setStatus: (status: AuthStatus) => void;
  setRateLimited: (retryAfter: number) => void;
  clear: () => void;
}

// Older builds persisted both tokens (including the 7-day refresh token) in localStorage. Remove them for good.
export const LEGACY_AUTH_KEY = "flowboard-auth";
try {
  localStorage.removeItem(LEGACY_AUTH_KEY);
} catch {
  /* storage unavailable (private mode, blocked): nothing to clean up */
}

export const useAuth = create<AuthState>()((set) => ({
  status: "restoring",
  access: null,
  user: null,
  retryAfter: null,
  signIn: ({ access, user }) => set({ access, user, status: "authenticated", retryAfter: null }),
  setAccess: (access) => set({ access }),
  setUser: (user) => set({ user }),
  setStatus: (status) => set({ status, retryAfter: null }),
  setRateLimited: (retryAfter) => set({ status: "rate_limited", retryAfter }),
  clear: () => set({ access: null, user: null, status: "anonymous", retryAfter: null }),
}));
