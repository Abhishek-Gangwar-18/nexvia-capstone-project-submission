import { api } from './api';
import { queryClient } from './queryClient';
import { useAuth } from '../store/auth';

async function establish({ token, user }) {
  queryClient.clear();
  useAuth.getState().setSession(token, user);
  return user;
}

export async function login(credentials) {
  const { data } = await api.post('/auth/login', credentials);
  return establish(data);
}

export async function register(payload) {
  const { data } = await api.post('/auth/register', payload);
  return establish(data);
}

export async function logout() {
  try {
    await api.post('/auth/logout');
  } catch {
    /* token may already be invalid — clearing locally is enough */
  }
  useAuth.getState().clear();
  queryClient.clear();
}

export async function refreshMe() {
  const { data } = await api.get('/auth/me');
  useAuth.getState().setUser(data.user);
  return data.user;
}

/** Where each role lands after signing in. */
export function homeFor(user) {
  if (!user) return '/';
  if (user.role === 'admin') return '/admin';
  if (user.role === 'vendor') return user.vendor?.status === 'approved' ? '/vendor' : '/vendor/onboarding';
  return '/';
}
