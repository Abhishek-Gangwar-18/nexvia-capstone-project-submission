import { useState } from 'react';
import NotFound from './NotFound';
import { useParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { BadgeCheck, CalendarDays, MapPin, Package, Star, TrendingUp } from 'lucide-react';
import { api } from '../lib/api';
import { cn, compactNumber, formatDate, gradientFor } from '../lib/format';
import { useCategoryName } from '../lib/hooks';
import { StoreAvatar } from '../components/ui/Brand';
import { ProductGrid } from '../components/product/ProductCard';
import Pagination from '../components/ui/Pagination';
import { ErrorState, PageLoader } from '../components/ui/Feedback';
import { SORT_OPTIONS } from './Search';

export default function StorePage() {
  const { storeId } = useParams();
  const categoryName = useCategoryName();
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState('popular');
  const [page, setPage] = useState(1);

  const storeQuery = useQuery({
    queryKey: ['store', storeId],
    queryFn: () => api.get(`/stores/${storeId}`).then((r) => r.data.store),
  });
  const store = storeQuery.data;

  const products = useQuery({
    queryKey: ['store-products', store?._id, category, sort, page],
    queryFn: () => api.get('/products', { params: { vendor: store._id, category: category || undefined, sort, page, limit: 12 } }).then((r) => r.data),
    enabled: Boolean(store?._id),
    placeholderData: keepPreviousData,
  });

  if (storeQuery.isLoading) return <PageLoader />;
  if (storeQuery.error?.response?.status === 404) return <NotFound title="Store not available" message="This store doesn’t exist or is no longer available." />;
  if (storeQuery.error) {
    return (
      <div className="container-page py-16">
        <ErrorState error={storeQuery.error} onRetry={storeQuery.refetch} />
      </div>
    );
  }

  const stats = [
    { icon: Star, label: 'Rating', value: store.stats.rating ? store.stats.rating.toFixed(1) : '—' },
    { icon: Package, label: 'Products', value: store.stats.products },
    { icon: TrendingUp, label: 'Units sold', value: compactNumber(store.stats.sold) },
    { icon: CalendarDays, label: 'Selling since', value: formatDate(store.createdAt, { day: undefined }) },
  ];

  return (
    <div>
      {/* Banner is decoration only: no text sits on it, so any banner colour/image stays readable. */}
      <div className={cn('relative h-40 overflow-hidden bg-gradient-to-br sm:h-56', gradientFor(store.storeName))}>
        {store.banner ? <img src={store.banner} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <div className="absolute inset-0 bg-grid opacity-30" />}
      </div>
      <div className="container-page">
        {/* Logo and text sit side by side below the banner, vertically centred on each other. */}
        <div className="mt-6 flex items-center gap-4 sm:gap-6">
          <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="shrink-0">
            <StoreAvatar store={store} size="h-20 w-20 text-2xl sm:h-24 sm:w-24 sm:text-3xl" rounded="rounded-3xl" className="shadow-lg" />
          </motion.div>
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 font-display text-2xl font-extrabold tracking-tight sm:text-3xl">
              <span className="truncate">{store.storeName}</span> <BadgeCheck className="h-6 w-6 shrink-0 text-sky-500" />
            </h1>
            {store.tagline && <p className="mt-0.5 muted">{store.tagline}</p>}
            {store.address?.city && (
              <p className="mt-1.5 flex items-center gap-1 text-xs muted">
                <MapPin className="h-3.5 w-3.5" /> {store.address.city}, {store.address.state}
              </p>
            )}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          {stats.map(({ icon: Icon, label, value }) => (
            <div key={label} className="card flex items-center gap-3 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
                <Icon className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs muted">{label}</p>
                <p className="font-display text-lg font-bold">{value}</p>
              </div>
            </div>
          ))}
        </div>

        {store.description && <p className="mt-6 max-w-3xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{store.description}</p>}

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
            <button type="button" onClick={() => { setCategory(''); setPage(1); }} className={cn('chip shrink-0', !category && 'chip-active')}>
              All products
            </button>
            {store.stats.categories.map((c) => (
              <button key={c} type="button" onClick={() => { setCategory(c); setPage(1); }} className={cn('chip shrink-0', category === c && 'chip-active')}>
                {categoryName(c)}
              </button>
            ))}
          </div>
          <select aria-label="Sort products" value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} className="input w-auto py-2">
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>Sort: {o.label}</option>
            ))}
          </select>
        </div>

        <div className={cn('mt-6 transition-opacity', products.isFetching && !products.isLoading && 'opacity-60')}>
          <ProductGrid products={products.data?.items || []} loading={products.isLoading} />
          <Pagination className="mt-10" page={page} pages={products.data?.pages} onChange={setPage} />
        </div>
      </div>
    </div>
  );
}
