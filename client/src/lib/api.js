import axios from 'axios';
import { useAuth } from '../store/auth';

const base = import.meta.env.VITE_API_URL?.replace(/\/$/, '');

/** In development requests go through the Vite proxy (/api); in production VITE_API_URL points at the deployed API. */
export const API_URL = base ? `${base}/api` : '/api';

export const api = axios.create({ baseURL: API_URL, timeout: 25000 });

api.interceptors.request.use((config) => {
  const { token } = useAuth.getState();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && useAuth.getState().token) {
      useAuth.getState().clear();
    }
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
