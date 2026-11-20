import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search, Store } from 'lucide-react';
import { api } from '../lib/api';
import { useDebounce } from '../lib/hooks';
import Pagination from '../components/ui/Pagination';
import { StoreCard } from './Home';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/Feedback';

export default function Stores() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounce(q.trim(), 300);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['stores', search, page],
    queryFn: () => api.get('/stores', { params: { q: search || undefined, page, limit: 24 } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const stores = data?.items || [];

  return (
    <div className="container-page py-8">
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-600 to-indigo-700 px-6 py-10 text-white sm:px-10">
        <div className="absolute inset-0 bg-grid opacity-20" />
        <div className="relative max-w-xl">
          <h1 className="font-display text-3xl font-extrabold sm:text-4xl">Discover independent stores</h1>
          <p className="mt-2 text-indigo-100">Every store on Vendora is verified by our team before it goes live.</p>
          <div className="relative mt-6">
            <Search className="absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input value={q} onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }} placeholder="Search stores…" className="h-12 w-full rounded-2xl bg-white pl-11 text-sm text-zinc-900 outline-none focus:ring-4 focus:ring-white/30" />
          </div>
        </div>
      </div>

      <div className="mt-8">
        {error ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-64" />
            ))}
          </div>
        ) : stores.length === 0 ? (
          <EmptyState icon={Store} title="No stores match your search" />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {stores.map((store, i) => (
              <StoreCard key={store._id} store={store} index={i} />
            ))}
          </div>
        )}
        {data?.pages > 1 && <Pagination page={page} pages={data.pages} onChange={setPage} className="mt-8" />}
      </div>
    </div>
  );
}
