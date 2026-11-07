import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { useAuth } from "@/store/auth";

/** All requests go to /api; Vite (dev) and nginx (prod) proxy it to Django. */
export const api = axios.create({ baseURL: "/api" });

const NO_REFRESH = ["/auth/login/", "/auth/register/", "/auth/refresh/", "/auth/logout/", "/auth/password-reset/", "/auth/password-reset/confirm/"];

api.interceptors.request.use((config) => {
  const token = useAuth.getState().access;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Single-flight refresh: concurrent 401s wait for one refresh call instead of racing
// (refresh tokens rotate, so a second parallel refresh would be rejected).
let refreshing: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const refresh = useAuth.getState().refresh;
  if (!refresh) return null;
  try {
    const { data } = await axios.post<{ access: string; refresh?: string }>("/api/auth/refresh/", { refresh });
    useAuth.getState().setTokens(data.access, data.refresh ?? refresh);
    return data.access;
  } catch {
    return null;
  }
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
    const url = original?.url ?? "";
    if (error.response?.status === 401 && original && !original._retried && !NO_REFRESH.includes(url)) {
      original._retried = true;
      refreshing ??= refreshAccessToken().finally(() => {
        refreshing = null;
      });
      const token = await refreshing;
      if (token) {
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      }
      useAuth.getState().clear();
    }
    return Promise.reject(error);
  },
);
