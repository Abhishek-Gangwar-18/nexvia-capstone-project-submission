import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { BadgeCheck, MessageSquarePlus, Pencil, Star, Store, ThumbsUp, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { cn, timeAgo } from '../../lib/format';
import { useAuth } from '../../store/auth';
import { useAuthModal } from '../../store/authModal';
import { Stars, StarPicker } from '../ui/Rating';
import { Spinner } from '../ui/Feedback';
import { UserAvatar } from '../ui/Brand';
import ImageUploader from '../ui/ImageUploader';

function ReviewForm({ productId, existing, onDone }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(existing?.title || '');
  const [comment, setComment] = useState(existing?.comment || '');
  const [photos, setPhotos] = useState(existing?.photos || []);

  const mutation = useMutation({
    mutationFn: () =>
      existing
        ? api.patch(`/products/${productId}/reviews/${existing._id}`, { title, comment, photos })
        : api.post(`/products/${productId}/reviews`, { title, comment, photos }),
    onSuccess: () => {
      toast.success(existing ? 'Review updated' : 'Thanks for your review!');
      queryClient.invalidateQueries({ queryKey: ['reviews', productId] });
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
        if (comment.trim().length < 10) return toast.error('Tell others a little more (at least 10 characters)');
        return mutation.mutate();
      }}
      className="overflow-hidden"
    >
      <div className="card mt-4 space-y-4 p-5">
        <div>
          <label className="label" htmlFor="review-title">Headline</label>
          <input id="review-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} className="input" placeholder="What stood out?" />
        </div>
        <div>
          <label className="label" htmlFor="review-comment">Your review</label>
          <textarea id="review-comment" value={comment} onChange={(e) => setComment(e.target.value)} rows={4} maxLength={2000} className="input resize-none" placeholder="How was the quality, fit, delivery…? (min. 10 characters)" />
          <p className="mt-1 text-right text-xs muted">{comment.length}/2000</p>
        </div>
        <div>
          <p className="label">Photos (up to 5)</p>
          <ImageUploader value={photos} onChange={setPhotos} max={5} folder="reviews" />
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

/** The customer's single star rating; changing the stars saves it right away. */
function MyRating({ productId, value }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (stars) => api.put(`/products/${productId}/rating`, { value: stars }),
    onSuccess: () => {
      toast.success('Rating saved');
      queryClient.invalidateQueries({ queryKey: ['reviews', productId] });
      queryClient.invalidateQueries({ queryKey: ['product'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <div className="mt-3">
      <StarPicker value={value || 0} onChange={(stars) => save.mutate(stars)} />
      <p className="mt-1 text-[11px] muted">{value ? 'Tap the stars to change your rating' : 'Tap to rate — one rating per customer'}</p>
    </div>
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
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const helpful = useMutation({
    mutationFn: ({ reviewId, voted }) => (voted ? api.delete : api.post)(`/products/${product._id}/reviews/${reviewId}/helpful`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reviews', product._id] }),
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
  const voted = new Set(query.data?.pages.flatMap((p) => p.myVotes || []) || []);

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
            <p className="font-semibold">Rate & review</p>
            {!user ? (
              <>
                <p className="mt-1 text-sm muted">Bought this product? Help other shoppers decide.</p>
                <button type="button" onClick={() => useAuthModal.getState().open('login')} className="btn btn-secondary mt-4 w-full">
                  Sign in to rate & review
                </button>
              </>
            ) : !first ? null : !first.canReview ? (
              <p className="mt-1 text-sm muted">You can rate and review this product once an order with it has been delivered to you.</p>
            ) : (
              <>
                <p className="mt-1 text-sm muted">Your rating</p>
                <MyRating productId={product._id} value={first.myRating} />
                {first.reviewsLeft > 0 ? (
                  <button type="button" onClick={() => setEditing((e) => (e ? null : {}))} className="btn btn-secondary mt-4 w-full">
                    <MessageSquarePlus className="h-4 w-4" /> Write a review
                  </button>
                ) : (
                  <p className="mt-3 text-xs muted">You have written the maximum of 20 reviews for this product.</p>
                )}
              </>
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
              <option value="helpful">Most helpful</option>
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
                  className={cn('card group relative p-5', mine.has(review._id) && 'pb-11 ring-2 ring-brand-500/40')}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <UserAvatar user={{ name: review.name }} className="h-9 w-9" />
                      <div>
                        <p className="text-sm font-semibold">
                          {review.name} {mine.has(review._id) && <span className="text-xs text-brand-600">(you)</span>}
                        </p>
                        <div className="flex items-center gap-2">
                          {review.authorRating && <Stars value={review.authorRating} size="h-3 w-3" />}
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
                  {review.photos?.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {review.photos.map((photo) => (
                        <a key={photo.url} href={photo.url} target="_blank" rel="noreferrer" className="h-16 w-16 overflow-hidden rounded-lg bg-zinc-50 dark:bg-white/5">
                          <img src={photo.url} alt="Review photo" loading="lazy" className="h-full w-full object-cover" />
                        </a>
                      ))}
                    </div>
                  )}
                  {review.reply?.text && (
                    <div className="mt-3 rounded-xl bg-zinc-50 p-3 text-sm dark:bg-white/[0.04]">
                      <p className="flex items-center gap-1.5 text-xs font-semibold"><Store className="h-3.5 w-3.5" /> Response from the seller <span className="font-normal muted">· {timeAgo(review.reply.at)}</span></p>
                      <p className="mt-1 text-zinc-600 dark:text-zinc-300">{review.reply.text}</p>
                    </div>
                  )}
                  {!mine.has(review._id) && (
                    <button
                      type="button"
                      disabled={!user || helpful.isPending}
                      onClick={() => helpful.mutate({ reviewId: review._id, voted: voted.has(review._id) })}
                      className={cn('mt-3 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition', voted.has(review._id) ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-400/30 dark:bg-brand-500/10 dark:text-brand-300' : 'border-zinc-200 text-zinc-500 hover:border-zinc-300 dark:border-white/10')}
                      title={user ? 'Mark as helpful' : 'Sign in to vote'}
                    >
                      <ThumbsUp className="h-3.5 w-3.5" /> Helpful{review.helpfulCount ? ` (${review.helpfulCount})` : ''}
                    </button>
                  )}
                  {mine.has(review._id) && (
                    // Icon-only, bottom right, shown on hover (or keyboard focus); always visible on touch screens, which can't hover.
                    <div className="absolute right-3 bottom-3 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                      <button
                        type="button"
                        onClick={() => setEditing(review)}
                        title="Edit review"
                        aria-label="Edit review"
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove.mutate(review._id)}
                        disabled={remove.isPending}
                        title="Delete review"
                        aria-label="Delete review"
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-rose-500 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:hover:bg-rose-500/10"
                      >
                        <Trash2 className="h-4 w-4" />
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
