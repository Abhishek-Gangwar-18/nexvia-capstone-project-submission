import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Ban, Check, ExternalLink, Mail, MapPin, Phone, RotateCcw, Search, Settings2, Store, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { compactNumber, formatDate } from '../../lib/format';
import { useDebounce } from '../../lib/hooks';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { Field, Segmented } from '../../components/ui/Controls';
import { Modal } from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import Pagination from '../../components/ui/Pagination';
import { StoreAvatar } from '../../components/ui/Brand';
import { EmptyState, ErrorState, Skeleton, Spinner } from '../../components/ui/Feedback';

function ReviewModal({ vendor, mode, onClose, onSubmit, saving }) {
  const [reason, setReason] = useState('');
  const [commissionRate, setCommissionRate] = useState(vendor?.commissionRate ?? '');
  if (!vendor) return null;
  // 'reject' and 'suspend' both need a reason that is shown to the seller.
  const isReject = mode === 'reject' || mode === 'suspend';
  const isSuspend = mode === 'suspend';
  return (
    <Modal
      open
      onClose={onClose}
      title={isReject ? `${isSuspend ? 'Suspend' : 'Reject'} ${vendor.storeName}?` : `Commission · ${vendor.storeName}`}
      description={isSuspend ? 'The store and its products go offline. The seller will see your note.' : isReject ? 'The seller will see your note and can update their application.' : 'Override the platform commission for this store.'}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button
            type="button"
            disabled={saving || (isReject && reason.trim().length < 5)}
            className={isReject ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={() =>
              onSubmit(
                isReject
                  ? { status: isSuspend ? 'suspended' : 'rejected', rejectionReason: reason.trim() }
                  : { commissionRate: commissionRate === '' ? null : Number(commissionRate) },
              )
            }
          >
            {saving && <Spinner className="h-4 w-4" />} {isSuspend ? 'Suspend store' : isReject ? 'Reject application' : 'Save'}
          </button>
        </>
      }
    >
      {isReject ? (
        <Field label="Reason (shown to the seller)" hint="At least 5 characters">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} className="input resize-none" placeholder="e.g. Please upload a clear store logo and a valid GSTIN." />
        </Field>
      ) : (
        <div className="space-y-4">
          <Field label="Commission rate (%)" hint="Leave empty to use the platform default">
            <input type="number" min="0" max="50" step="0.5" value={commissionRate} onChange={(e) => setCommissionRate(e.target.value)} className="input" />
          </Field>
        </div>
      )}
    </Modal>
  );
}

export default function Vendors() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(null);
  const search = useDebounce(q, 300);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-vendors', status, search, page],
    queryFn: () => api.get('/admin/vendors', { params: { status: status || undefined, q: search || undefined, page } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  const update = useMutation({
    mutationFn: ({ id, body }) => api.patch(`/admin/vendors/${id}`, body).then((r) => r.data.vendor),
    onSuccess: (vendor) => {
      toast.success(`${vendor.storeName} → ${vendor.status}`);
      setModal(null);
      queryClient.invalidateQueries({ queryKey: ['admin-vendors'] });
      queryClient.invalidateQueries({ queryKey: ['admin-analytics'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const counts = data?.counts || {};
  const tabs = [
    { value: '', label: 'All' },
    { value: 'pending', label: 'Pending', count: counts.pending || 0 },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'suspended', label: 'Suspended' },
  ];

  return (
    <div>
      <PageHeader title="Vendors" description="Review seller applications, set commission overrides and manage store status." />
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="overflow-x-auto scrollbar-none">
          <Segmented size="sm" value={status} onChange={(v) => { setParams(v ? { status: v } : {}); setPage(1); }} options={tabs} />
        </div>
        <div className="relative lg:w-64">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search stores" className="input py-2 pl-9" />
        </div>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-56" />)}</div>
      ) : !data.items.length ? (
        <EmptyState icon={Store} title="No vendors here" description={status === 'pending' ? 'No applications waiting for review.' : 'Try another filter.'} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.items.map((v, i) => (
            <motion.div key={v._id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }} className="card p-5">
              <div className="flex items-start gap-4">
                <StoreAvatar store={v} size="h-14 w-14" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-display text-lg font-bold">{v.storeName}</p>
                    <StatusBadge status={v.status} pulse={v.status === 'pending'} />
                  </div>
                  <p className="text-sm muted">{v.tagline}</p>
                  <p className="mt-1 text-xs muted">Owner: {v.owner?.name} · applied {formatDate(v.createdAt)}</p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div className="rounded-xl bg-zinc-50 p-2.5 dark:bg-white/[0.03]"><p className="muted">Products</p><p className="font-bold">{v.productCount}</p></div>
                <div className="rounded-xl bg-zinc-50 p-2.5 dark:bg-white/[0.03]"><p className="muted">Units sold</p><p className="font-bold">{compactNumber(v.unitsSold)}</p></div>
                <div className="rounded-xl bg-zinc-50 p-2.5 dark:bg-white/[0.03]"><p className="muted">Commission</p><p className="font-bold">{v.commissionRate ?? 'Default'}{v.commissionRate !== null && v.commissionRate !== undefined ? '%' : ''}</p></div>
                <div className="rounded-xl bg-zinc-50 p-2.5 dark:bg-white/[0.03]"><p className="muted">Payouts</p><p className="truncate font-bold">{v.payoutLinked ? 'Linked' : 'Manual'}</p></div>
              </div>
              <div className="mt-3 space-y-1 text-xs muted">
                <p className="flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" /> {v.email} <Phone className="ml-2 h-3.5 w-3.5" /> {v.phone}</p>
                <p className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" /> {v.address?.city}, {v.address?.state} · GSTIN {v.gstin || '—'}</p>
              </div>
              {v.rejectionReason && <p className="mt-3 rounded-xl bg-rose-50 p-2.5 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">Note: {v.rejectionReason}</p>}
              <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-zinc-100 pt-4 dark:border-white/5">
                {v.status === 'approved' && (
                  <Link to={`/store/${v._id}`} target="_blank" className="btn btn-ghost btn-sm"><ExternalLink className="h-3.5 w-3.5" /> Store</Link>
                )}
                <button type="button" onClick={() => setModal({ vendor: v, mode: 'settings' })} className="btn btn-ghost btn-sm"><Settings2 className="h-3.5 w-3.5" /> Commission</button>
                {v.status === 'pending' && (
                  <button type="button" onClick={() => setModal({ vendor: v, mode: 'reject' })} className="btn btn-secondary btn-sm text-rose-600"><X className="h-3.5 w-3.5" /> Reject</button>
                )}
                {v.status === 'approved' && (
                  <button type="button" onClick={() => setModal({ vendor: v, mode: 'suspend' })} className="btn btn-secondary btn-sm text-rose-600"><Ban className="h-3.5 w-3.5" /> Suspend</button>
                )}
                {['pending', 'suspended'].includes(v.status) && (
                  <button type="button" disabled={update.isPending} onClick={() => update.mutate({ id: v._id, body: { status: 'approved' } })} className="btn btn-primary btn-sm">
                    {v.status === 'suspended' ? <RotateCcw className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />} {v.status === 'suspended' ? 'Reactivate' : 'Approve'}
                  </button>
                )}
              </div>
            </motion.div>
          ))}
        </div>
      )}
      <Pagination className="mt-6" page={page} pages={data?.pages} onChange={setPage} />
      {modal && <ReviewModal vendor={modal.vendor} mode={modal.mode} onClose={() => setModal(null)} saving={update.isPending} onSubmit={(body) => update.mutate({ id: modal.vendor._id, body })} />}
    </div>
  );
}
