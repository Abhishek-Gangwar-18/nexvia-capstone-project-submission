import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Ban, LogIn, RefreshCw } from 'lucide-react';
import { refreshAccessToken } from '../lib/api';
import { formatDate } from '../lib/format';
import { homeFor } from '../lib/session';
import { useAuth } from '../store/auth';
import { LogoMark } from '../components/ui/Brand';
import { Spinner } from '../components/ui/Feedback';
import LoginForm from '../components/auth/LoginForm';

/**
 * The only screen a blocked account gets, on every URL (App.jsx). The API refuses this browser too,
 * so it opens again only when an admin unblocks the account or another account signs in here.
 */
export default function Blocked() {
  const blocked = useAuth((s) => s.blocked);
  const [checking, setChecking] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const navigate = useNavigate();

  // Asks the API again. Still blocked -> ACCOUNT_BLOCKED and the screen stays (lib/api.js). Only a clear
  // "no session" (401) or a new token means the block was lifted; network errors, 429s and 5xx change nothing.
  const check = useCallback(async () => {
    setChecking(true);
    try {
      await refreshAccessToken();
    } catch (error) {
      if (error.response?.status === 401) useAuth.getState().unblock();
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  // Signing in to the blocked account again brings the blocked screen back.
  useEffect(() => setSigningIn(false), [blocked]);

  if (signingIn) {
    return (
      <div className="min-h-screen">
        <div className="container-page pt-6">
          <button type="button" onClick={() => setSigningIn(false)} className="btn btn-ghost">
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
        </div>
        <div className="container-page flex justify-center py-10">
          <div className="card w-full max-w-md p-6 sm:p-8">
            <LoginForm onDone={(user) => navigate(homeFor(user), { replace: true })} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="card w-full max-w-lg p-8 text-center sm:p-10">
        <LogoMark className="mx-auto h-10 w-10" />
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 14, delay: 0.1 }}
          className="mx-auto mt-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-rose-50 dark:bg-rose-500/10"
        >
          <Ban className="h-8 w-8 text-rose-600 dark:text-rose-400" />
        </motion.div>
        <h1 className="mt-5 font-display text-2xl font-extrabold tracking-tight">You are not allowed to use Vendora</h1>
        <p className="mt-2 muted">
          Your account has been blocked by an administrator{blocked?.blockedAt ? ` on ${formatDate(blocked.blockedAt)}` : ''}. You can’t browse, buy or sell
          while it is blocked.
        </p>
        {blocked?.reason && (
          <div className="mt-5 rounded-xl bg-rose-50 px-4 py-3 text-left text-sm dark:bg-rose-500/10">
            <p className="text-xs font-semibold tracking-wide text-rose-700 uppercase dark:text-rose-300">Reason</p>
            <p className="mt-1 text-rose-900 dark:text-rose-100">{blocked.reason}</p>
          </div>
        )}
        <p className="mt-5 text-sm muted">If you think this is a mistake, contact Vendora support.</p>
        <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
          <button type="button" onClick={check} disabled={checking} className="btn btn-secondary">
            {checking ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />} Check again
          </button>
          <button type="button" onClick={() => setSigningIn(true)} className="btn btn-ghost">
            <LogIn className="h-4 w-4" /> Sign in with another account
          </button>
        </div>
      </motion.div>
    </div>
  );
}
