import axios from "axios";
import { useAuth } from "@/store/auth";
import type { Me } from "@/types";

/**
 * Browser session handling (refresh token in an httpOnly cookie, access token in memory).
 *
 * - Every request sends `X-Auth-Mode: cookie`, so the server keeps the refresh token in the cookie and never
 *   returns it in a response body.
 * - Refreshes are serialised ACROSS TABS with the Web Locks API: refresh tokens rotate, and two tabs rotating
 *   the same cookie at once would revoke each other's session. Without Web Locks there is no safe cross-tab
 *   mutex, so automatic refresh is disabled: an expired access token sends the user to log in again.
 * - Login/logout are announced to other tabs with a BroadcastChannel. Tokens are never broadcast.
 */
export const AUTH_MODE_HEADER = { "X-Auth-Mode": "cookie" } as const;
const LOCK_NAME = "flowboard-refresh";

/** The refresh cookie is missing, expired or revoked: the user has to log in again. */
export class SessionExpired extends Error {
  constructor() {
    super("Your session has ended. Log in again.");
    this.name = "SessionExpired";
  }
}

/** The server rate-limited the refresh (429). The session is still valid: wait `retryAfter` seconds, then retry. */
export class RateLimited extends Error {
  constructor(public retryAfter: number) {
    super(`Too many requests right now. Try again in ${retryAfter} seconds.`);
    this.name = "RateLimited";
  }
}

/** Seconds from a Retry-After header (delta-seconds or an HTTP date); 30 when missing or unusable. */
export function retryAfterSeconds(value: unknown): number {
  const raw = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  const seconds = /^\d+$/.test(raw) ? Number(raw) : raw ? Math.ceil((Date.parse(raw) - Date.now()) / 1000) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 30;
}

export const canAutoRefresh = () => typeof navigator !== "undefined" && !!navigator.locks;

async function requestNewAccessToken(): Promise<string> {
  try {
    const { data } = await axios.post<{ access: string }>("/api/auth/refresh/", {}, { headers: AUTH_MODE_HEADER });
    return data.access;
  } catch (error) {
    // 401/400: the cookie is gone or invalid. Anything else (network, 5xx) is not proof the session ended.
    if (axios.isAxiosError(error) && error.response && [400, 401].includes(error.response.status)) {
      throw new SessionExpired();
    }
    // 429: rate limited, not logged out. Keep the session and say when to try again.
    if (axios.isAxiosError(error) && error.response?.status === 429) {
      throw new RateLimited(retryAfterSeconds(error.response.headers?.["retry-after"]));
    }
    throw error;
  }
}

let inFlight: Promise<string> | null = null;

/** One refresh at a time in this tab, and (with Web Locks) one at a time across all tabs. */
export function refreshAccessToken(): Promise<string> {
  if (inFlight) return inFlight;
  const tokenBefore = useAuth.getState().access;
  const run = async () => {
    // Re-check after waiting for the lock: if this tab already received a newer access token meanwhile, use it
    // instead of rotating the cookie again. (Another tab's refresh rotated the cookie but can't give this tab an
    // access token; that tab's turn with the lock is over, so our request uses the fresh cookie safely.)
    const current = useAuth.getState().access;
    if (current && current !== tokenBefore) return current;
    const access = await requestNewAccessToken();
    useAuth.getState().setAccess(access);
    return access;
  };
  const locked = (canAutoRefresh() ? navigator.locks.request(LOCK_NAME, run) : run()) as Promise<string>;
  const pending = locked.finally(() => {
    inFlight = null;
  });
  inFlight = pending;
  return pending;
}

let restoring: Promise<void> | null = null;

/**
 * Page load: get an access token from the cookie, then the user, then let protected routes render.
 * 401 (session ended) clears auth and shows login; 429 (rate limited) keeps the session and retries after
 * Retry-After; a network/server error keeps the cookie and offers a retry.
 */
export function restoreSession(): Promise<void> {
  if (restoring) return restoring;
  restoring = (async () => {
    const auth = useAuth.getState();
    auth.setStatus("restoring");
    try {
      const access = await refreshAccessToken();
      const { data: user } = await axios.get<Me>("/api/auth/me/", {
        headers: { ...AUTH_MODE_HEADER, Authorization: `Bearer ${access}` },
      });
      useAuth.getState().signIn({ access, user });
    } catch (error) {
      if (error instanceof SessionExpired) useAuth.getState().clear();
      else if (error instanceof RateLimited) useAuth.getState().setRateLimited(error.retryAfter);
      else useAuth.getState().setStatus("error");
    }
  })().finally(() => {
    restoring = null;
  });
  return restoring;
}

/**
 * Log out on the server first. Only a confirmed 204 (refresh token revoked, cookie cleared) ends the session
 * here and in other tabs. If the request fails (offline, 5xx) the httpOnly cookie is still valid and the page
 * can't remove it, so clearing local state would only look like a logout: a reload would restore the session.
 * Returns whether the logout happened; the caller keeps the user signed in and says so when it didn't.
 */
export async function logoutSession(beforeClear?: () => void | Promise<void>): Promise<boolean> {
  try {
    const response = await axios.post("/api/auth/logout/", {}, { headers: AUTH_MODE_HEADER });
    if (response.status !== 204) return false;
  } catch {
    return false;
  }
  await beforeClear?.(); // e.g. leave the protected page first, so it doesn't add a stale ?next=
  useAuth.getState().clear();
  announce("logout");
  return true;
}

/* ------------------------------------------------------------ cross-tab notices */

type Notice = { type: "login" } | { type: "logout" };
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("flowboard-auth") : null;

export function announce(type: Notice["type"]) {
  channel?.postMessage({ type } satisfies Notice);
}

/** Install once (App): another tab logged out → drop this tab's in-memory session; logged in → pick it up. */
export function listenToOtherTabs(onLogout: () => void): () => void {
  if (!channel) return () => {};
  const handler = (event: MessageEvent<Notice>) => {
    if (event.data?.type === "logout") {
      useAuth.getState().clear();
      onLogout();
    } else if (event.data?.type === "login" && useAuth.getState().status !== "authenticated") {
      void restoreSession();
    }
  };
  channel.addEventListener("message", handler);
  return () => channel.removeEventListener("message", handler);
}
