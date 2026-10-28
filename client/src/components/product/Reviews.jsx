import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { BadgeCheck, MessageSquarePlus, Pencil, Star, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { cn, timeAgo } from '../../lib/format';
import { useAuth } from '../../store/auth';
import { Stars, StarPicker } from '../ui/Rating';
import { Spinner } from '../ui/Feedback';
import { UserAvatar } from '../ui/Brand';

function ReviewForm({ productId, existing, onDone }) {
  const queryClient = useQueryClient();
  const [rating, setRating] = useState(existing?.rating || 0);
  const [title, setTitle] = useState(existing?.title || '');
  const [comment, setComment] = useState(existing?.comment || '');

  const mutation = useMutation({
    mutationFn: () =>
      existing
        ? api.patch(`/products/${productId}/reviews/${existing._id}`, { rating, title, comment })
        : api.post(`/products/${productId}/reviews`, { rating, title, comment }),
    onSuccess: () => {
      toast.success(existing ? 'Review updated' : 'Thanks for your review!');
      queryClient.invalidateQueries({ queryKey: ['reviews', productId] });
      queryClient.invalidateQueries({ queryKey: ['product'] });
      onDone();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <motion.form
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!rating) return toast.error('Pick a star rating');
        return mutation.mutate();
      }}
      className="overflow-hidden"
    >
      <div className="card mt-4 space-y-4 p-5">
        <div>
          <p className="label">Your rating</p>
          <StarPicker value={rating} onChange={setRating} />
        </div>
        <div>
          <label className="label" htmlFor="review-title">Headline</label>
          <input id="review-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} className="input" placeholder="What stood out?" />
        </div>
        <div>
          <label className="label" htmlFor="review-comment">Your review</label>
          <textarea id="review-comment" value={comment} onChange={(e) => setComment(e.target.value)} rows={4} maxLength={2000} className="input resize-none" placeholder="How was the quality, fit, delivery…? (min. 10 characters)" />
          <p className="mt-1 text-right text-xs muted">{comment.length}/2000</p>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onDone} className="btn btn-ghost">Cancel</button>
          <button type="submit" disabled={mutation.isPending} className="btn btn-primary">
            {mutation.isPending && <Spinner className="h-4 w-4" />} {existing ? 'Update review' : 'Submit review'}
          </button>
        </div>
      </div>
    </motion.form>
  );
}

export default function Reviews({ product }) {
  const user = useAuth((s) => s.user);
  const [sort, setSort] = useState('recent');
  const [ratingFilter, setRatingFilter] = useState(null);
  // null = closed, {} = new review, a review object = editing that review.
  const [editing, setEditing] = useState(null);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (reviewId) => api.delete(`/products/${product._id}/reviews/${reviewId}`),
    onSuccess: () => {
      toast.success('Review deleted');
      queryClient.invalidateQueries({ queryKey: ['reviews', product._id] });
      queryClient.invalidateQueries({ queryKey: ['product'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const query = useInfiniteQuery({
    queryKey: ['reviews', product._id, sort, ratingFilter, user?._id],
    queryFn: ({ pageParam }) =>
      api.get(`/products/${product._id}/reviews`, { params: { page: pageParam, limit: 5, sort, rating: ratingFilter || undefined } }).then((r) => r.data),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.pages ? last.page + 1 : undefined),
  });

  const first = query.data?.pages[0];
  const distribution = first?.distribution || { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const total = Object.values(distribution).reduce((a, b) => a + b, 0);
  const reviews = query.data?.pages.flatMap((p) => p.items) || [];
  const mine = new Set(first?.myReviewIds || []);

  return (
    <section id="reviews" className="scroll-mt-40">
      <h2 className="section-title">Ratings & reviews</h2>
      <div className="mt-6 grid gap-8 lg:grid-cols-[320px_1fr]">
        <div>
          <div className="card p-6">
            <div className="flex items-end gap-3">
              <span className="font-display text-5xl font-extrabold">{(product.rating || 0).toFixed(1)}</span>
              <div className="pb-1.5">
                <Stars value={product.rating || 0} size="h-4 w-4" />
                <p className="mt-1 text-xs muted">{total.toLocaleString('en-IN')} ratings</p>
              </div>
            </div>
            <div className="mt-5 space-y-2">
              {[5, 4, 3, 2, 1].map((r) => {
                const count = distribution[r] || 0;
                const pct = total ? (count / total) * 100 : 0;
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRatingFilter(ratingFilter === r ? null : r)}
                    className={cn('flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-xs transition hover:bg-zinc-50 dark:hover:bg-white/5', ratingFilter === r && 'bg-amber-50 dark:bg-amber-400/10')}
                  >
                    <span className="flex w-6 items-center gap-0.5 font-semibold">
                      {r} <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                    </span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-white/10">
                      <motion.span
                        className={cn('block h-full rounded-full', r >= 4 ? 'bg-emerald-500' : r === 3 ? 'bg-amber-400' : 'bg-rose-500')}
                        initial={{ width: 0 }}
                        whileInView={{ width: `${pct}%` }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.8, ease: 'easeOut' }}
                      />
                    </span>
                    <span className="w-8 text-right muted tabular-nums">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="card mt-4 p-5">
            <p className="font-semibold">Share your thoughts</p>
            <p className="mt-1 text-sm muted">Bought this product? Help other shoppers decide.</p>
            {!user ? (
              <Link to="/login" state={{ from: { pathname: `/product/${product._id}` } }} className="btn btn-secondary mt-4 w-full">
                Sign in to review
              </Link>
            ) : user.role !== 'customer' ? (
              <p className="mt-3 text-xs muted">Reviews can be written from customer accounts.</p>
            ) : (
              <button type="button" onClick={() => setEditing((e) => (e ? null : {}))} className="btn btn-secondary mt-4 w-full">
                <MessageSquarePlus className="h-4 w-4" /> Write a review
              </button>
            )}
            {first && user?.role === 'customer' && (
              <p className="mt-2 text-center text-[11px] muted">{first.hasPurchased ? '✓ Your review will show as a verified purchase' : 'Reviews from delivered orders get a verified badge'}</p>
            )}
          </div>
        </div>

        <div>
          <AnimatePresence>
            {editing && <ReviewForm key={editing._id || 'new'} productId={product._id} existing={editing._id ? editing : null} onDone={() => setEditing(null)} />}
          </AnimatePresence>

          <div className="mt-2 mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm muted">
              {ratingFilter ? `Showing ${ratingFilter}★ reviews` : 'All reviews'}
              {ratingFilter && (
                <button type="button" onClick={() => setRatingFilter(null)} className="ml-2 font-semibold text-brand-600">
                  Clear
                </button>
              )}
            </p>
            <select value={sort} onChange={(e) => setSort(e.target.value)} className="input w-auto py-1.5 text-xs">
              <option value="recent">Most recent</option>
              <option value="top">Highest rated</option>
              <option value="low">Lowest rated</option>
            </select>
          </div>

          {query.isLoading ? (
            <div className="flex justify-center py-10">
              <Spinner className="h-6 w-6 text-brand-600" />
            </div>
          ) : reviews.length === 0 ? (
            <p className="card p-8 text-center text-sm muted">No reviews {ratingFilter ? 'with this rating ' : ''}yet.</p>
          ) : (
            <ul className="space-y-3">
              {reviews.map((review, i) => (
                <motion.li
                  key={review._id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: (i % 5) * 0.04 }}
                  className={cn('card p-5', mine.has(review._id) && 'ring-2 ring-brand-500/40')}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <UserAvatar user={{ name: review.name }} className="h-9 w-9" />
                      <div>
                        <p className="text-sm font-semibold">
                          {review.name} {mine.has(review._id) && <span className="text-xs text-brand-600">(you)</span>}
                        </p>
                        <div className="flex items-center gap-2">
                          <Stars value={review.rating} size="h-3 w-3" />
                          <span className="text-[11px] muted">{timeAgo(review.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                    {review.verified && (
                      <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
                        <BadgeCheck className="h-3.5 w-3.5" /> Verified purchase
                      </span>
                    )}
                  </div>
                  {review.title && <p className="mt-3 text-sm font-semibold">{review.title}</p>}
                  <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{review.comment}</p>
                  {mine.has(review._id) && (
                    <div className="mt-3 flex justify-end gap-1">
                      <button type="button" onClick={() => setEditing(review)} className="btn btn-ghost btn-sm">
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>
                      <button type="button" onClick={() => remove.mutate(review._id)} disabled={remove.isPending} className="btn btn-ghost btn-sm text-rose-600">
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </button>
                    </div>
                  )}
                </motion.li>
              ))}
            </ul>
          )}
          {query.hasNextPage && (
            <button type="button" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage} className="btn btn-secondary mx-auto mt-4 flex">
              {query.isFetchingNextPage && <Spinner className="h-4 w-4" />} Load more reviews
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
