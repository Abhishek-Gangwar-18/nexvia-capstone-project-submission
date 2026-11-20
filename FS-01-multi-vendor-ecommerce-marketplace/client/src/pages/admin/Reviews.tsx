import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, MessageSquare, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { cn, timeAgo } from '../../lib/format';
import { useDebounce } from '../../lib/hooks';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { Segmented } from '../../components/ui/Controls';
import Pagination from '../../components/ui/Pagination';
import { ConfirmDialog } from '../../components/ui/Modal';
import { Stars } from '../../components/ui/Rating';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/Feedback';

const TABS = [
  { value: '', label: 'All' },
  { value: 'visible', label: 'Visible' },
  { value: 'hidden', label: 'Hidden' },
];

export default function AdminReviews() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [hiding, setHiding] = useState(null);
  const [reason, setReason] = useState('');
  const search = useDebounce(q, 300);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-reviews', status, search, page],
    queryFn: () => api.get('/admin/reviews', { params: { status: status || undefined, q: search || undefined, page, limit: 15 } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  const moderate = useMutation({
    mutationFn: ({ id, ...body }: Record<string, any>) => api.patch(`/admin/reviews/${id}`, body),
    onSuccess: (_, { status: next }) => {
      toast.success(next === 'hidden' ? 'Review hidden from shoppers' : 'Review visible again');
      setHiding(null);
      setReason('');
      queryClient.invalidateQueries({ queryKey: ['admin-reviews'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div>
      <PageHeader title="Reviews" description="Hide abusive or fake reviews. Hidden reviews stay on record; star ratings are separate and not affected." />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Segmented size="sm" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={TABS} />
        <div className="relative sm:w-72">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search review text" className="input py-2 pl-9" />
        </div>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading ? (
        <div className="space-y-3">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : !data.items.length ? (
        <EmptyState icon={MessageSquare} title="No reviews found" description="Try another filter." />
      ) : (
        <ul className="space-y-3">
          {data.items.map((r) => {
            const hidden = r.moderation?.status === 'hidden';
            return (
              <li key={r._id} className={cn('card p-5', hidden && 'opacity-70')}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <Link to={`/product/${r.product?._id}`} target="_blank" className="line-clamp-1 text-xs font-semibold text-brand-600 hover:underline dark:text-brand-300">{r.product?.title || 'Deleted product'}</Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-semibold">{r.name}</span>
                      {r.email && <span className="text-xs muted">{r.email}</span>}
                      {r.authorRating && <Stars value={r.authorRating} size="h-3 w-3" />}
                      <span className="text-[11px] muted">{timeAgo(r.createdAt)}</span>
                    </div>
                    {r.title && <p className="mt-2 text-sm font-semibold">{r.title}</p>}
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{r.comment}</p>
                    {hidden && <p className="mt-2 text-xs font-semibold text-rose-600">Hidden: {r.moderation.reason}</p>}
                  </div>
                  {hidden ? (
                    <button type="button" disabled={moderate.isPending} onClick={() => moderate.mutate({ id: r._id, status: 'visible' })} className="btn btn-secondary btn-sm"><Eye className="h-3.5 w-3.5" /> Show</button>
                  ) : (
                    <button type="button" onClick={() => setHiding(r)} className="btn btn-secondary btn-sm text-rose-600"><EyeOff className="h-3.5 w-3.5" /> Hide</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Pagination className="mt-6" page={page} pages={data?.pages} onChange={setPage} />

      <ConfirmDialog
        open={Boolean(hiding)}
        onClose={() => setHiding(null)}
        onConfirm={() => (reason.trim().length >= 3 ? moderate.mutate({ id: hiding._id, status: 'hidden', reason: reason.trim() }) : toast.error('Enter a reason (at least 3 characters)'))}
        loading={moderate.isPending}
        danger
        title="Hide this review?"
        description="Shoppers won't see it. The author's star rating still counts (ratings are separate)."
        confirmLabel="Hide review"
      >
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} rows={2} placeholder="Reason (kept on record)" className="input mt-3" />
      </ConfirmDialog>
    </div>
  );
}
