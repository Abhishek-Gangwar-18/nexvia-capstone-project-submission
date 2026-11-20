import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { PackageSearch, SlidersHorizontal, X } from 'lucide-react';
import { api } from '../lib/api';
import { cn, money } from '../lib/format';
import { useCategoryName } from '../lib/hooks';
import Filters from '../components/product/Filters';
import { ProductGrid } from '../components/product/ProductCard';
import Pagination from '../components/ui/Pagination';
import { EmptyState, ErrorState } from '../components/ui/Feedback';

export const SORT_OPTIONS = [
  { value: 'popular', label: 'Popularity' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'rating', label: 'Customer rating' },
  { value: 'newest', label: 'Newest first' },
  { value: 'discount', label: 'Biggest discount' },
];

/** Reads filters from the URL so every search is shareable and survives refresh. */
export function useFilters(fixed = {}) {
  const [params, setParams] = useSearchParams();
  const filters = {
    q: params.get('q') || '',
    category: params.get('category') || '',
    brands: (params.get('brand') || '').split(',').filter(Boolean),
    minPrice: params.get('minPrice') ? Number(params.get('minPrice')) : undefined,
    maxPrice: params.get('maxPrice') ? Number(params.get('maxPrice')) : undefined,
    rating: params.get('rating') ? Number(params.get('rating')) : undefined,
    inStock: params.get('inStock') === '1',
    // Unknown values (e.g. an old ?sort=relevance link) show as the default, like the API treats them.
    sort: SORT_OPTIONS.some((o) => o.value === params.get('sort')) ? params.get('sort') : 'popular',
    page: Number(params.get('page')) || 1,
  };
  const update = (changes, { resetPage = true } = {}) => {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([key, value]) => {
      if (value === undefined || value === '' || value === null) next.delete(key);
      else next.set(key, String(value));
    });
    if (resetPage && !('page' in changes)) next.delete('page');
    setParams(next);
  };
  const query = {
    ...Object.fromEntries([...params.entries()]),
    ...fixed,
    limit: 24,
  };
  return { filters, update, query, params };
}

export default function Search() {
  const { filters, update, query } = useFilters();
  const categoryName = useCategoryName();
  const [drawer, setDrawer] = useState(false);
  const topRef = useRef(null);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['search', query],
    queryFn: () => api.get('/products', { params: query }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });

  // Keep slider bounds stable while a price filter is active (facets shrink to the filtered range).
  const boundsRef = useRef({ key: '', min: 0, max: 0 });
  const boundsKey = `${filters.q}|${filters.category}|${filters.brands.join()}`;
  const priceBounds = useMemo(() => {
    const priceFiltered = filters.minPrice !== undefined || filters.maxPrice !== undefined;
    if (data && (!priceFiltered || boundsRef.current.key !== boundsKey)) {
      boundsRef.current = { key: boundsKey, min: Math.floor(data.facets.price.min || 0), max: Math.ceil(data.facets.price.max || 0) };
    }
    return boundsRef.current;
  }, [data, boundsKey, filters.minPrice, filters.maxPrice]);

  useEffect(() => {
    if (filters.page > 1) topRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [filters.page]);

  const chips = [
    filters.q && { key: 'q', label: `“${filters.q}”`, clear: { q: undefined } },
    filters.category && { key: 'category', label: categoryName(filters.category), clear: { category: undefined, brand: undefined } },
    ...filters.brands.map((b) => ({ key: `b-${b}`, label: b, clear: { brand: filters.brands.filter((x) => x !== b).join(',') || undefined } })),
    (filters.minPrice !== undefined || filters.maxPrice !== undefined) && {
      key: 'price',
      label: `${money(filters.minPrice ?? priceBounds.min)} – ${money(filters.maxPrice ?? priceBounds.max)}`,
      clear: { minPrice: undefined, maxPrice: undefined },
    },
    filters.rating && { key: 'rating', label: `${filters.rating}★ & up`, clear: { rating: undefined } },
    filters.inStock && { key: 'stock', label: 'In stock', clear: { inStock: undefined } },
  ].filter(Boolean);

  const title = filters.q ? `Results for “${filters.q}”` : filters.category ? categoryName(filters.category) : 'All products';
  const filterPanel = <Filters filters={filters} facets={data?.facets} priceBounds={priceBounds} categoryName={categoryName} onChange={update} />;

  return (
    <div className="container-page py-6" ref={topRef}>
      <nav className="mb-4 text-xs muted">
        <Link to="/" className="hover:text-brand-600">Home</Link> <span className="mx-1">/</span> <span className="text-zinc-700 dark:text-zinc-300">{title}</span>
      </nav>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm muted">
            {data ? `${data.total.toLocaleString('en-IN')} products` : 'Searching…'}
          </div>
          {data?.relaxed && (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">No product matches every word, so these match some of them.</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setDrawer(true)} className="btn btn-secondary lg:hidden">
            <SlidersHorizontal className="h-4 w-4" /> Filters {chips.length > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[10px] text-white">{chips.length}</span>}
          </button>
          <select aria-label="Sort products" value={filters.sort} onChange={(e) => update({ sort: e.target.value })} className="input w-auto cursor-pointer py-2 pr-8 font-medium">
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                Sort: {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {chips.length > 0 && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 pt-4">
              <AnimatePresence>
                {chips.map((chip) => (
                  <motion.button
                    key={chip.key}
                    layout
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    type="button"
                    onClick={() => update(chip.clear)}
                    className="chip chip-active"
                  >
                    {chip.label} <X className="h-3 w-3" />
                  </motion.button>
                ))}
              </AnimatePresence>
              <button type="button" onClick={() => update({ q: undefined, category: undefined, brand: undefined, minPrice: undefined, maxPrice: undefined, rating: undefined, inStock: undefined })} className="text-xs font-semibold text-zinc-500 hover:text-rose-600">
                Clear all
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-6 grid gap-6 lg:grid-cols-[260px_1fr]">
        <aside className="hidden lg:block">
          <div className="card sticky top-36 px-5 py-2">{filterPanel}</div>
        </aside>

        <div className={cn('transition-opacity', isFetching && !isLoading && 'opacity-60')}>
          {error ? (
            <ErrorState error={error} onRetry={refetch} />
          ) : !isLoading && data?.items.length === 0 ? (
            <EmptyState
              icon={PackageSearch}
              title="No products found"
              description="Try a different search term or remove some filters."
              action={
                <Link to="/search" className="btn btn-primary">
                  Clear search
                </Link>
              }
            />
          ) : (
            <>
              <ProductGrid products={data?.items || []} loading={isLoading} count={12} className="xl:grid-cols-4" />
              <Pagination className="mt-10" page={data?.page || 1} pages={data?.pages} onChange={(page) => update({ page }, { resetPage: false })} />
            </>
          )}
        </div>
      </div>

      <AnimatePresence>
        {drawer && (
          <div className="fixed inset-0 z-[70] lg:hidden">
            <motion.div className="absolute inset-0 bg-zinc-950/50 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDrawer(false)} />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col rounded-t-3xl bg-white dark:bg-surface-dark"
            >
              <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-white/5">
                <h2 className="font-display text-lg font-bold">Filters</h2>
                <button type="button" onClick={() => setDrawer(false)} className="btn-icon" aria-label="Close filters">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5">{filterPanel}</div>
              <div className="border-t border-zinc-100 p-4 dark:border-white/5">
                <button type="button" onClick={() => setDrawer(false)} className="btn btn-primary w-full">
                  Show {data?.total ?? ''} results
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
