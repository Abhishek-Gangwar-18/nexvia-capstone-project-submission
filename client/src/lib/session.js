import { api, sessionConfirmedAt } from './api';
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

let lastAsked = 0;

/**
 * Asks the API whether this session still stands, so a block (or a logout elsewhere) shows up on the
 * next click even when the page comes from the query cache. Skipped when an API answer confirmed the
 * session within `maxAge` ms, or a check was just sent. The API client reacts to the answer.
 */
export function checkSession(maxAge = 2000) {
  const now = Date.now();
  if (!useAuth.getState().user || now - Math.max(sessionConfirmedAt(), lastAsked) < maxAge) return;
  lastAsked = now;
  api.get('/auth/status').catch(() => {});
}

/** After a page change: the new page's own requests usually confirm the session, so only ask if none did. */
export function checkSessionAfterNavigation(delay = 1500) {
  const changedAt = Date.now();
  setTimeout(() => {
    if (sessionConfirmedAt() < changedAt) checkSession();
  }, delay);
}

/**
 * Reloads the profile. One request at a time (single flight): callers at the same moment (App on load,
 * which React StrictMode runs twice in development, and the Checkout page) share it instead of each
 * sending GET /auth/me. `fresh` (after a save) always sends a new request, so the answer includes the change.
 */
let loadingMe = null;
export function refreshMe({ fresh = false } = {}) {
  if (loadingMe && !fresh) return loadingMe;
  const request = api.get('/auth/me').then(({ data }) => {
    // An older request finishing late must not overwrite a newer profile.
    if (loadingMe === request) useAuth.getState().setUser(data.user);
    return data.user;
  });
  loadingMe = request;
  request.then(
    () => loadingMe === request && (loadingMe = null),
    () => loadingMe === request && (loadingMe = null),
  );
  return request;
}

/** Where each role lands after signing in. */
export function homeFor(user) {
  if (!user) return '/';
  if (user.role === 'admin') return '/admin';
  if (user.role === 'vendor') return user.vendor?.status === 'approved' ? '/vendor' : '/vendor/onboarding';
  return '/';
}
