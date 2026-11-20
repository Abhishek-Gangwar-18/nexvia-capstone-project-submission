import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { announce, AUTH_MODE_HEADER, canAutoRefresh, refreshAccessToken, SessionExpired } from "@/lib/session";
import { useAuth } from "@/store/auth";

/** All requests go to /api; Vite (dev) and nginx (prod) proxy it to Django. Same origin, so the httpOnly
 *  refresh cookie (path /api/auth/) is sent by the browser where it applies; the page never sees it. */
export const api = axios.create({ baseURL: "/api", headers: { ...AUTH_MODE_HEADER } });

const NO_REFRESH = ["/auth/login/", "/auth/register/", "/auth/refresh/", "/auth/logout/", "/auth/password-reset/", "/auth/password-reset/confirm/"];

api.interceptors.request.use((config) => {
  const token = useAuth.getState().access;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
    const url = original?.url ?? "";
    if (error.response?.status !== 401 || !original || original._retried || NO_REFRESH.includes(url)) {
      return Promise.reject(error);
    }
    if (!canAutoRefresh()) {
      // No Web Locks: refreshing could collide with another tab's rotation, so ask the user to log in again.
      useAuth.getState().clear();
      return Promise.reject(error);
    }
    original._retried = true;
    try {
      const token = await refreshAccessToken();
      original.headers.Authorization = `Bearer ${token}`;
      return api(original);
    } catch (refreshError) {
      if (refreshError instanceof SessionExpired) {
        useAuth.getState().clear();
        announce("logout"); // the cookie is shared, so every tab's session ended
      }
      // A network/server error during refresh keeps the session: the request fails, the user can retry.
      return Promise.reject(error);
    }
  },
);
