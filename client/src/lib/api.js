import axios from 'axios';
import { useAuth } from '../store/auth';
import { queryClient } from './queryClient';

const base = import.meta.env.VITE_API_URL?.replace(/\/$/, '');

/**
 * No /api prefix: in development requests go to the same origin (e.g. /auth/me) and the Vite proxy forwards
 * them to the API; in production VITE_API_URL is the API's origin.
 */
export const API_URL = base || '';

// withCredentials: the refresh cookie is sent to the auth routes (also when the API is on another domain).
export const api = axios.create({ baseURL: API_URL, timeout: 25000, withCredentials: true });

/**
 * The API answers 403 ACCOUNT_BLOCKED to every request from a blocked account's browser: drop the
 * session and its cached data, and the app shows the blocked screen instead of the site (App.jsx).
 */
export const isBlockedError = (error) => error?.response?.status === 403 && error.response.data?.details?.code === 'ACCOUNT_BLOCKED';
function handleBlocked(error) {
  if (!isBlockedError(error)) return false;
  const { reason = null, blockedAt = null } = error.response.data.details;
  useAuth.getState().block({ reason, blockedAt });
  queryClient.clear();
  return true;
}

/**
 * When the API last confirmed this session active: every answer from a route that checked it carries
 * X-Session (server middleware/auth.js protect), and so does a successful refresh. lib/session.js only
 * sends GET /auth/status when nothing has confirmed the session recently.
 */
let sessionSeenAt = 0;
export const sessionConfirmedAt = () => sessionSeenAt;
export const markSessionConfirmed = () => {
  sessionSeenAt = Date.now();
};

/**
 * Access tokens last ~15 minutes. One refresh runs at a time (single flight): every request that needs
 * a token waits for the same promise. The refresh cookie rotates on each call.
 */
let refreshing = null;
export function refreshAccessToken() {
  if (!refreshing) {
    refreshing = axios
      .post(`${API_URL}/auth/refresh`, null, { withCredentials: true, timeout: 15000, headers: { 'X-Requested-With': 'vendora' } })
      .then(({ data }) => {
        markSessionConfirmed();
        useAuth.getState().setSession(data.accessToken, data.user);
        return data.accessToken;
      })
      .catch((error) => {
        // The refresh session itself ended (idle/max age, logged out everywhere, password changed elsewhere).
        if (!handleBlocked(error) && error.response?.status === 401 && useAuth.getState().user) useAuth.getState().expire();
        throw error;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

const isAuthCall = (url = '') => /\/auth\/(login|register|refresh|logout)$/.test(url);

api.interceptors.request.use(async (config) => {
  let { token } = useAuth.getState();
  // Signed in (profile restored) but no token in memory yet, e.g. after a page reload.
  if (!token && useAuth.getState().user && !isAuthCall(config.url)) token = await refreshAccessToken().catch(() => null);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => {
    if (response.headers['x-session']) markSessionConfirmed();
    return response;
  },
  async (error) => {
    if (handleBlocked(error)) return Promise.reject(error);
    const { config, response } = error;
    const code = response?.data?.details?.code;
    // Expired access token: refresh once and replay the request.
    if (response?.status === 401 && code === 'TOKEN_EXPIRED' && config && !config._retried) {
      config._retried = true;
      try {
        const token = await refreshAccessToken();
        config.headers.Authorization = `Bearer ${token}`;
        return api(config);
      } catch {
        /* falls through to sign-out below */
      }
    }
    if (response?.status === 401 && !isAuthCall(config?.url) && useAuth.getState().user) useAuth.getState().expire();
    return Promise.reject(error);
  },
);

export function errorMessage(error, fallback = 'Something went wrong') {
  if (error?.response?.data?.message) return error.response.data.message;
  if (error?.code === 'ECONNABORTED') return 'The server took too long to respond';
  if (error?.request && !error.response) return 'Cannot reach the server. Is the API running on port 5050?';
  return error?.message || fallback;
}

/** Blob responses (PDF invoices) carry their JSON error inside the blob. */
export async function downloadFile(url, filename) {
  try {
    const res = await api.get(url, { responseType: 'blob' });
    const href = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  } catch (error) {
    if (error.response?.data instanceof Blob) {
      try {
        const body = JSON.parse(await error.response.data.text());
        throw new Error(body.message);
      } catch (parsed) {
        throw parsed instanceof SyntaxError ? error : parsed;
      }
    }
    throw error;
  }
}
