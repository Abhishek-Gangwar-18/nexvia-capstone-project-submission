import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Pencil, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { Segmented } from '../../components/ui/Controls';
import Pagination from '../../components/ui/Pagination';
import { Stars } from '../../components/ui/Rating';
import { EmptyState, ErrorState, Skeleton, Spinner } from '../../components/ui/Feedback';

const TABS = [
  { value: 'no', label: 'Awaiting reply' },
  { value: 'yes', label: 'Replied' },
  { value: '', label: 'All' },
];

interface ReplyBoxProps {
  review?: any;
  onDone?: any;
}

function ReplyBox({ review, onDone }: ReplyBoxProps) {
  const [text, setText] = useState(review.reply?.text || '');
  const save = useMutation({
    mutationFn: (_vars: void) => api.put(`/vendor/reviews/${review._id}/reply`, { text }),
    onSuccess: () => {
      toast.success('Reply posted');
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <div className="mt-3 space-y-2">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={1000} className="input resize-none" placeholder="Thank the customer or answer their concern (shown publicly)" />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="btn btn-ghost btn-sm">Cancel</button>
        <button type="button" disabled={save.isPending || text.trim().length < 2} onClick={() => save.mutate()} className="btn btn-primary btn-sm">
          {save.isPending && <Spinner className="h-3.5 w-3.5" />} Post reply
        </button>
      </div>
    </div>
  );
}

export default function VendorReviews() {
  const queryClient = useQueryClient();
  const [replied, setReplied] = useState('no');
  const [page, setPage] = useState(1);
  const [replying, setReplying] = useState(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['vendor-reviews', replied, page],
    queryFn: () => api.get('/vendor/reviews', { params: { replied: replied || undefined, page, limit: 10 } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const refresh = () => {
    setReplying(null);
    queryClient.invalidateQueries({ queryKey: ['vendor-reviews'] });
  };
  const removeReply = useMutation({
    mutationFn: (id: string) => api.delete(`/vendor/reviews/${id}/reply`),
    onSuccess: () => {
      toast.success('Reply removed');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div>
      <PageHeader title="Reviews" description="What customers say about your products. Replies are shown publicly under the review." />
      <Segmented size="sm" className="mb-4" value={replied} onChange={(v) => { setReplied(v); setPage(1); }} options={TABS} />

      {error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading ? (
        <div className="space-y-3">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : !data.items.length ? (
        <EmptyState icon={MessageSquare} title="No reviews here" description={replied === 'no' ? 'Every review has a reply. Nice work!' : 'Reviews on your products will show up here.'} />
      ) : (
        <ul className="space-y-3">
          {data.items.map((r) => (
            <li key={r._id} className="card p-5">
              <div className="flex items-start gap-3">
                {r.product?.thumbnail && <img src={r.product.thumbnail} alt="" className="h-12 w-12 shrink-0 rounded-lg bg-zinc-50 object-contain p-1 dark:bg-white/5" />}
                <div className="min-w-0 flex-1">
                  <Link to={`/product/${r.product?._id}`} target="_blank" className="line-clamp-1 text-xs font-semibold text-brand-600 hover:underline dark:text-brand-300">{r.product?.title}</Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold">{r.name}</span>
                    {r.authorRating && <Stars value={r.authorRating} size="h-3 w-3" />}
                    <span className="text-[11px] muted">{timeAgo(r.createdAt)}</span>
                  </div>
                  {r.title && <p className="mt-2 text-sm font-semibold">{r.title}</p>}
                  <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{r.comment}</p>
                  {r.photos?.length > 0 && (
                    <div className="mt-2 flex gap-2">{r.photos.map((p) => <img key={p.url} src={p.url} alt="" className="h-14 w-14 rounded-lg object-cover" />)}</div>
                  )}

                  {replying === r._id ? (
                    <ReplyBox review={r} onDone={refresh} />
                  ) : r.reply?.text ? (
                    <div className="mt-3 rounded-xl bg-zinc-50 p-3 text-sm dark:bg-white/[0.04]">
                      <p className="text-xs font-semibold">Your reply <span className="font-normal muted">· {timeAgo(r.reply.at)}</span></p>
                      <p className="mt-1">{r.reply.text}</p>
                      <div className="mt-2 flex gap-1">
                        <button type="button" onClick={() => setReplying(r._id)} className="btn btn-ghost btn-sm"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                        <button type="button" disabled={removeReply.isPending} onClick={() => removeReply.mutate(r._id)} className="btn btn-ghost btn-sm text-rose-600"><Trash2 className="h-3.5 w-3.5" /> Remove</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setReplying(r._id)} className="btn btn-secondary btn-sm mt-3"><MessageSquare className="h-3.5 w-3.5" /> Reply</button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Pagination className="mt-6" page={page} pages={data?.pages} onChange={setPage} />
    </div>
  );
}
