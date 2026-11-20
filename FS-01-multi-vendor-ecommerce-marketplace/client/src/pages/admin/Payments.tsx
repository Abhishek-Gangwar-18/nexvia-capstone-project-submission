import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, RefreshCw, Undo2, Wallet } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { formatDate, formatDateTime, money } from '../../lib/format';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { Segmented } from '../../components/ui/Controls';
import Pagination from '../../components/ui/Pagination';
import StatusBadge from '../../components/ui/StatusBadge';
import { ConfirmDialog } from '../../components/ui/Modal';
import { EmptyState, ErrorState, Skeleton, Spinner } from '../../components/ui/Feedback';

const TABS = [
  { value: 'failed', label: 'Failed' },
  { value: 'pending', label: 'Pending' },
  { value: 'succeeded', label: 'Succeeded' },
];

/** Stores whose payouts are frozen after a payout destination change (#9d). */
function PayoutHolds() {
  const queryClient = useQueryClient();
  const [releasing, setReleasing] = useState(null);
  const { data } = useQuery({ queryKey: ['payout-holds'], queryFn: () => api.get('/admin/vendors', { params: { payoutHold: '1', limit: 50 } }).then((r) => r.data.items) });
  const release = useMutation({
    mutationFn: (id: string) => api.patch(`/admin/vendors/${id}/payout-hold`, { action: 'release' }),
    onSuccess: () => {
      toast.success('Payouts resumed');
      setReleasing(null);
      queryClient.invalidateQueries({ queryKey: ['payout-holds'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (!data?.length) return null;
  return (
    <div className="card mb-6 p-5">
      <p className="flex items-center gap-2 font-semibold"><Lock className="h-4 w-4 text-amber-600" /> Payouts on hold</p>
      <p className="mt-1 text-sm muted">These stores changed where they get paid while money was waiting. Confirm the change with the seller, then resume payouts.</p>
      <ul className="mt-3 divide-y divide-zinc-100 dark:divide-white/5">
        {data.map((v) => (
          <li key={v._id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <span className="font-semibold">{v.storeName}</span>
            <span className="muted">{v.payoutHold.reason} · since {formatDate(v.payoutHold.since)}</span>
            <button type="button" onClick={() => setReleasing(v)} className="btn btn-secondary btn-sm ml-auto">Confirm & resume</button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={Boolean(releasing)}
        onClose={() => setReleasing(null)}
        onConfirm={() => release.mutate(releasing._id)}
        loading={release.isPending}
        title={`Resume payouts for ${releasing?.storeName}?`}
        description="Only do this after confirming with the seller that they made the change. Waiting payouts go to the new destination."
        confirmLabel="Resume payouts"
      />
    </div>
  );
}

export default function AdminPayments() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('failed');
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-refunds', status, page],
    queryFn: () => api.get('/admin/refunds', { params: { status, page, limit: 15 } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/admin/refunds/${id}/retry`),
    onSuccess: ({ data: res }) => {
      toast[res.refund.status === 'failed' ? 'error' : 'success'](res.refund.status === 'failed' ? `Still failing: ${res.refund.lastError}` : `Refund ${res.refund.status}`);
      queryClient.invalidateQueries({ queryKey: ['admin-refunds'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const reconcile = useMutation({
    mutationFn: (_vars: void) => api.post('/admin/payments/reconcile').then((r) => r.data.report),
    onSuccess: (r) => {
      toast.success(`Reconciled: ${r.paymentsFinalized} payments, ${r.refundsUpdated} refunds, ${r.payoutClaimsReset} payouts${r.errors.length ? `, ${r.errors.length} errors` : ''}`);
      queryClient.invalidateQueries({ queryKey: ['admin-refunds'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const payouts = useMutation({
    mutationFn: (_vars: void) => api.post('/admin/payouts/release').then((r) => r.data.result),
    onSuccess: (r) => toast.success(`Payouts: ${r.released} released, ${r.held} on hold, ${r.failed} failed`),
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div>
      <PageHeader
        title="Payments"
        description="Refunds that need attention, payout holds, and a check of Stripe against the database."
        actions={
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={payouts.isPending} onClick={() => payouts.mutate()} className="btn btn-secondary">
              {payouts.isPending ? <Spinner className="h-4 w-4" /> : <Wallet className="h-4 w-4" />} Release due payouts
            </button>
            <button type="button" disabled={reconcile.isPending} onClick={() => reconcile.mutate()} className="btn btn-primary">
              {reconcile.isPending ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />} Reconcile with Stripe
            </button>
          </div>
        }
      />
      <PayoutHolds />

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 p-4 dark:border-white/5">
          <p className="flex items-center gap-2 font-semibold"><Undo2 className="h-4 w-4 text-brand-600" /> Refunds</p>
          <Segmented size="sm" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={TABS} />
        </div>
        {error ? (
          <ErrorState error={error} onRetry={refetch} className="m-4" />
        ) : isLoading ? (
          <div className="space-y-2 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : !data.items.length ? (
          <EmptyState icon={Undo2} title={status === 'failed' ? 'No failed refunds' : 'Nothing here'} description={status === 'failed' ? 'Every refund went through.' : ''} />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr><th>Order</th><th>Reason</th><th className="text-right">Amount</th><th>Status</th><th>Attempts</th><th>Updated</th><th /></tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r._id}>
                    <td><Link to={`/admin/orders/${r.order?._id}`} className="font-mono text-xs font-semibold text-brand-600">{r.order?.orderNumber || '—'}</Link></td>
                    <td className="text-xs capitalize">{r.reason} · by {r.initiatedBy?.by}</td>
                    <td className="text-right font-semibold tabular-nums">{money(r.amount)}</td>
                    <td>
                      <StatusBadge status={r.status} />
                      {r.lastError && <p className="mt-0.5 max-w-[240px] text-[11px] text-rose-600">{r.lastError}</p>}
                    </td>
                    <td className="text-xs tabular-nums">{r.attempts}</td>
                    <td className="text-xs muted">{formatDateTime(r.updatedAt)}</td>
                    <td>
                      {r.status !== 'succeeded' && (
                        <button type="button" disabled={retry.isPending} onClick={() => retry.mutate(r._id)} className="btn btn-secondary btn-sm">Retry</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Pagination className="mt-6" page={page} pages={data?.pages} onChange={setPage} />
    </div>
  );
}
