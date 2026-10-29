import { api } from './api';
import { queryClient } from './queryClient';
import { useAuth } from '../store/auth';

async function establish({ accessToken, user }) {
  queryClient.clear();
  useAuth.getState().setSession(accessToken, user);
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

function signedOut() {
  useAuth.getState().clear();
  queryClient.clear();
}

/** Ends this device's session (the server reads the refresh cookie and clears it). */
export async function logout() {
  try {
    await api.post('/auth/logout');
  } catch {
    /* already signed out on the server — clearing locally is enough */
  }
  signedOut();
}

/** Ends every session of the account, this device included. */
export async function logoutEverywhere() {
  const { data } = await api.post('/auth/logout-all');
  signedOut();
  return data.message;
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
