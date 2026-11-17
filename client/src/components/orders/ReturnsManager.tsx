import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, PackageCheck, RotateCcw, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, money } from '../../lib/format';
import { RETURN_REASON_LABELS } from '../../lib/status';
import { PageHeader } from '../layout/DashboardLayout';
import { Segmented, Switch } from '../ui/Controls';
import Pagination from '../ui/Pagination';
import StatusBadge from '../ui/StatusBadge';
import { Modal } from '../ui/Modal';
import { EmptyState, ErrorState, Skeleton, Spinner } from '../ui/Feedback';

const TABS = [
  { value: 'requested', label: 'To review' },
  { value: 'approved', label: 'Awaiting item' },
  { value: 'received', label: 'Received' },
  { value: 'refunded', label: 'Refunded' },
  { value: '', label: 'All' },
];

/**
 * Returns queue shared by sellers (/vendor/returns) and admins (/admin/returns; they see every store
 * and can take any step). Approve or reject, then mark the item received after inspection.
 */
interface ReturnsManagerProps {
  scope?: any;
}

export default function ReturnsManager({ scope }: ReturnsManagerProps) {
  const base = scope === 'admin' ? '/admin/returns' : '/vendor/returns';
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('requested');
  const [page, setPage] = useState(1);
  const [acting, setActing] = useState(null); // { ret, kind: 'reject' | 'receive' }
  const [note, setNote] = useState('');
  const [restock, setRestock] = useState(true);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['returns', scope, status, page],
    queryFn: () => api.get(base, { params: { status: status || undefined, page, limit: 10 } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  const run = useMutation({
    mutationFn: ({ ret, path, body }: Record<string, any>) => (path === 'decide' ? api.patch(`${base}/${ret._id}`, body) : api.post(`${base}/${ret._id}/${path}`, body)),
    onSuccess: ({ data: res }) => {
      toast.success(res.return.status === 'refunded' ? `Refunded ${money(res.return.amount)}` : `Return ${res.return.status}`);
      setActing(null);
      setNote('');
      queryClient.invalidateQueries({ queryKey: ['returns', scope] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div>
      <PageHeader
        title="Returns"
        description={scope === 'admin' ? 'Every return across stores. Sellers handle them; step in when needed.' : 'Review return requests, then confirm the item came back. The customer is refunded what they paid.'}
      />
      <Segmented size="sm" className="mb-4" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={TABS} />

      {error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading ? (
        <div className="space-y-3">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : !data.items.length ? (
        <EmptyState icon={RotateCcw} title="No returns here" description="Return requests show up here." />
      ) : (
        <ul className="space-y-3">
          {data.items.map((r) => (
            <li key={r._id} className="card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={r.status} />
                    <span className="text-sm font-semibold">{RETURN_REASON_LABELS[r.reasonCode]}</span>
                    <span className="text-xs muted">· {r.customer?.name}{scope === 'admin' && r.vendor?.storeName ? ` · ${r.vendor.storeName}` : ''} · {formatDateTime(r.createdAt)}</span>
                  </div>
                  <p className="mt-2 text-sm">{r.items.map((i) => `${i.quantity} × ${i.title}`).join(', ')}</p>
                  {r.note && <p className="mt-1 text-sm muted">“{r.note}”</p>}
                  {r.photos?.length > 0 && (
                    <div className="mt-2 flex gap-2">{r.photos.map((p) => <a key={p.url} href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt="" className="h-14 w-14 rounded-lg object-cover" /></a>)}</div>
                  )}
                  <p className="mt-2 text-xs muted">
                    Refund {money(r.amount)}{r.shippingRefund ? ` (incl. shipping ${money(r.shippingRefund)})` : ''} · your share {money(r.vendorShare)} is deducted from the payout
                    {scope === 'admin' && <> · <Link to={`/admin/orders/${r.order}`} className="font-semibold text-brand-600">order</Link></>}
                  </p>
                  {r.vendorNote && <p className="mt-1 text-xs muted">Note: {r.vendorNote}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {r.status === 'requested' && (
                    <>
                      <button type="button" disabled={run.isPending} onClick={() => run.mutate({ ret: r, path: 'decide', body: { action: 'approve' } })} className="btn btn-primary btn-sm"><Check className="h-3.5 w-3.5" /> Approve</button>
                      <button type="button" onClick={() => setActing({ ret: r, kind: 'reject' })} className="btn btn-secondary btn-sm text-rose-600"><X className="h-3.5 w-3.5" /> Reject</button>
                    </>
                  )}
                  {r.status === 'approved' && (
                    <button type="button" onClick={() => setActing({ ret: r, kind: 'receive' })} className="btn btn-primary btn-sm"><PackageCheck className="h-3.5 w-3.5" /> Item received</button>
                  )}
                  {r.status === 'received' && scope === 'admin' && (
                    <button type="button" disabled={run.isPending} onClick={() => run.mutate({ ret: r, path: 'refund' })} className="btn btn-secondary btn-sm">Retry refund</button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Pagination className="mt-6" page={page} pages={data?.pages} onChange={setPage} />

      <Modal
        open={Boolean(acting)}
        onClose={() => setActing(null)}
        title={acting?.kind === 'reject' ? 'Reject this return?' : 'Item received and inspected?'}
        description={acting?.kind === 'reject' ? 'Tell the customer why.' : `The customer is refunded ${money(acting?.ret.amount || 0)} right away.`}
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setActing(null)}>Cancel</button>
            <button
              type="button"
              className={acting?.kind === 'reject' ? 'btn btn-danger' : 'btn btn-primary'}
              disabled={run.isPending || (acting?.kind === 'reject' && note.trim().length < 3)}
              onClick={() =>
                acting.kind === 'reject'
                  ? run.mutate({ ret: acting.ret, path: 'decide', body: { action: 'reject', note: note.trim() } })
                  : run.mutate({ ret: acting.ret, path: 'receive', body: { restock, note: note.trim() || undefined } })
              }
            >
              {run.isPending && <Spinner className="h-4 w-4" />} {acting?.kind === 'reject' ? 'Reject return' : 'Confirm & refund'}
            </button>
          </>
        }
      >
        {acting?.kind === 'receive' && (
          <label className="mb-3 flex items-center justify-between rounded-xl bg-zinc-50 px-4 py-3 text-sm dark:bg-white/[0.03]">
            <span>Put back on sale<span className="block text-xs muted">Turn off if the item is damaged</span></span>
            <Switch checked={restock} onChange={setRestock} label="Restock" />
          </label>
        )}
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} placeholder={acting?.kind === 'reject' ? 'Reason (required)' : 'Inspection note (optional)'} className="input" />
      </Modal>
    </div>
  );
}
