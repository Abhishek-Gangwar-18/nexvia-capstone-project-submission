import type * as React from 'react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ExternalLink, Link2, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { Modal } from '../ui/Modal';
import { Spinner } from '../ui/Feedback';

/** Asks for the account password before changing where payouts go. */
interface PasswordModalProps {
  open?: boolean;
  title?: React.ReactNode;
  description?: React.ReactNode;
  busy?: any;
  onSubmit?: any;
  onClose?: () => void;
}

function PasswordModal({ open, title, description, busy, onSubmit, onClose }: PasswordModalProps) {
  const [password, setPassword] = useState('');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !password} onClick={() => onSubmit(password)}>
            {busy && <Spinner className="h-4 w-4" />} Continue to Stripe
          </button>
        </>
      }
    >
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="input" placeholder="Account password" autoComplete="current-password" />
    </Modal>
  );
}

/**
 * Stripe Connect status for the vendor: connect (Stripe-hosted onboarding), finish onboarding, open the
 * Stripe Express dashboard, or replace the account. Bank details are entered on Stripe, never here.
 */
export default function StripeConnectCard() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [asking, setAsking] = useState(null); // 'connect' | 'replace'
  const { data, isLoading, refetch } = useQuery({ queryKey: ['vendor-stripe'], queryFn: () => api.get('/vendor/stripe').then((r) => r.data) });

  // Back from Stripe onboarding: refresh the status from Stripe.
  useEffect(() => {
    const back = params.get('stripe');
    if (!back) return;
    refetch().then(({ data: s }) => {
      if (back === 'return') toast[s?.payoutsEnabled ? 'success' : 'error'](s?.payoutsEnabled ? 'Stripe connected. Payouts are enabled.' : 'Stripe onboarding is not finished yet.');
    });
    setParams({}, { replace: true });
  }, [params, refetch, setParams]);

  const go = useMutation({
    mutationFn: ({ path, currentPassword }: Record<string, any>) => api.post(path, currentPassword ? { currentPassword } : {}).then((r) => r.data),
    onSuccess: (res) => {
      if (res.payoutsFrozen) toast('Payouts waiting to be paid are frozen until an admin confirms the new account.', { icon: '🔒' });
      queryClient.invalidateQueries({ queryKey: ['vendor-stripe'] });
      window.location.assign(res.url);
    },
    onError: (err) => {
      if (err.response?.data?.details?.code === 'PASSWORD_REQUIRED' && !asking) setAsking('connect');
      else toast.error(errorMessage(err));
    },
  });

  if (isLoading) return <div className="card p-5"><Spinner className="h-5 w-5" /></div>;
  if (!data?.available) {
    return (
      <div className="card flex items-start gap-3 p-5 text-sm">
        <Link2 className="h-5 w-5 shrink-0 text-zinc-400" />
        <div>
          <p className="font-semibold">Manual settlement</p>
          <p className="muted">Stripe isn&apos;t configured on this marketplace, so Vendora pays your earnings to your bank account from this ledger.</p>
        </div>
      </div>
    );
  }

  const ready = data.connected && data.payoutsEnabled;
  return (
    <div className="card space-y-4 p-5">
      {data.payoutHold && (
        <p className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-400/10 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Payouts are on hold since {formatDate(data.payoutHold.since)}: {data.payoutHold.reason}. An admin will confirm the change, then payouts resume.
        </p>
      )}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white ${ready ? 'bg-gradient-to-br from-emerald-500 to-teal-600' : 'bg-gradient-to-br from-indigo-500 to-violet-600'}`}>
          {ready ? <CheckCircle2 className="h-6 w-6" /> : <Link2 className="h-6 w-6" />}
        </div>
        <div className="flex-1 text-sm">
          {ready ? (
            <>
              <p className="font-semibold">Stripe connected · <span className="font-mono">{data.accountId}</span></p>
              <p className="muted">Your share of each package is transferred to this account automatically once the return window after delivery has passed.</p>
            </>
          ) : data.connected ? (
            <>
              <p className="font-semibold">Stripe onboarding not finished</p>
              <p className="muted">Finish the Stripe form (identity and bank account) to receive automatic payouts. Until then Vendora settles payouts manually.</p>
            </>
          ) : (
            <>
              <p className="font-semibold">Get paid automatically with Stripe</p>
              <p className="muted">Connect a Stripe account. You enter your bank details on Stripe&apos;s secure page; Vendora never sees them.</p>
            </>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {!data.connected && (
            <button type="button" disabled={go.isPending} onClick={() => go.mutate({ path: '/vendor/stripe/onboarding' })} className="btn btn-primary btn-sm">
              {go.isPending && <Spinner className="h-3.5 w-3.5" />} Connect Stripe
            </button>
          )}
          {data.connected && !data.detailsSubmitted && (
            <button type="button" disabled={go.isPending} onClick={() => go.mutate({ path: '/vendor/stripe/onboarding' })} className="btn btn-primary btn-sm">
              {go.isPending && <Spinner className="h-3.5 w-3.5" />} Continue onboarding
            </button>
          )}
          {data.detailsSubmitted && (
            <button type="button" disabled={go.isPending} onClick={() => api.post('/vendor/stripe/dashboard').then((r) => window.open(r.data.url, '_blank', 'noopener')).catch((err) => toast.error(errorMessage(err)))} className="btn btn-secondary btn-sm">
              <ExternalLink className="h-3.5 w-3.5" /> Stripe dashboard
            </button>
          )}
          {data.connected && (
            <button type="button" onClick={() => setAsking('replace')} className="btn btn-ghost btn-sm">
              <RefreshCw className="h-3.5 w-3.5" /> Use another account
            </button>
          )}
        </div>
      </div>
      <PasswordModal
        open={Boolean(asking)}
        title={asking === 'replace' ? 'Use another Stripe account?' : 'Confirm with your password'}
        description={asking === 'replace' ? 'Payouts still waiting go on hold until an admin confirms the new account.' : 'Changing where payouts go needs your account password.'}
        busy={go.isPending}
        onClose={() => setAsking(null)}
        onSubmit={(currentPassword) => go.mutate({ path: asking === 'replace' ? '/vendor/stripe/replace' : '/vendor/stripe/onboarding', currentPassword })}
      />
    </div>
  );
}
