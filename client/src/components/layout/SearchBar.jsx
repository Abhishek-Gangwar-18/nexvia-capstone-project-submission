import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpRight, Clock, LayoutGrid, Search, SpellCheck, X } from 'lucide-react';
import { api } from '../../lib/api';
import { cn, money } from '../../lib/format';
import { useClickOutside, useDebounce } from '../../lib/hooks';
import { Spinner } from '../ui/Feedback';

const RECENT_KEY = 'vendora-recent-searches';
const readRecent = () => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    return [];
  }
};
const saveRecent = (q) => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...readRecent().filter((r) => r !== q)].slice(0, 5)));
  } catch {
    /* ignore */
  }
};

const POPULAR = ['iPhone', 'Laptop', 'Perfume', 'Sneakers', 'Watch', 'Sofa'];

/** Search box with Elasticsearch-powered typeahead, recent searches and keyboard navigation. */
export default function SearchBar({ className, autoFocus = false, onDone }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') || '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [recent, setRecent] = useState(readRecent);
  const inputRef = useRef(null);
  const debounced = useDebounce(query.trim(), 200);

  useEffect(() => setQuery(params.get('q') || ''), [params]);

  const { data, isFetching } = useQuery({
    queryKey: ['suggest', debounced],
    queryFn: () => api.get('/products/suggest', { params: { q: debounced } }).then((r) => r.data),
    enabled: debounced.length >= 2,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);
  const ref = useClickOutside(close);

  const showSuggestions = debounced.length >= 2 && data;
  const correction = showSuggestions ? data.didYouMean : null;
  const options = showSuggestions
    ? [
        ...(correction ? [{ type: 'correction', key: 'did-you-mean', label: correction, to: `/search?q=${encodeURIComponent(correction)}`, term: correction }] : []),
        ...(data.categories || []).map((c) => ({ type: 'category', key: `c-${c._id}`, label: c.name, to: `/search?category=${c._id}`, image: c.image })),
        ...(data.products || []).map((p) => ({ type: 'product', key: p._id, label: p.title, to: `/product/${p._id}`, image: p.thumbnail, price: p.price })),
      ]
    : [];

  const go = (to, term) => {
    if (term) {
      saveRecent(term);
      setRecent(readRecent());
    }
    close();
    inputRef.current?.blur();
    onDone?.();
    navigate(to);
  };

  const submit = (e) => {
    e?.preventDefault();
    if (active >= 0 && options[active]) return go(options[active].to, options[active].term);
    const q = query.trim();
    if (!q) return go('/search');
    return go(`/search?q=${encodeURIComponent(q)}`, q);
  };

  const onKeyDown = (e) => {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Escape') {
      close();
      inputRef.current?.blur();
    }
  };

  /** "Did you mean": the words that differ from what was typed are bold, like Google. */
  const correctedWords = (text) => {
    const typed = debounced.toLowerCase().split(/\s+/);
    return text.split(' ').map((word, i) => (
      <span key={i}>
        {i > 0 && ' '}
        {word === typed[i] ? word : <b className="font-bold italic text-brand-600 dark:text-brand-300">{word}</b>}
      </span>
    ));
  };

  const highlight = (text) => {
    const q = debounced.toLowerCase();
    const index = text.toLowerCase().indexOf(q);
    if (index < 0 || !q) return text;
    return (
      <>
        {text.slice(0, index)}
        <mark className="bg-transparent font-bold text-brand-600 dark:text-brand-300">{text.slice(index, index + q.length)}</mark>
        {text.slice(index + q.length)}
      </>
    );
  };

  return (
    <div ref={ref} className={cn('relative', className)}>
      <form onSubmit={submit} className="group relative">
        <Search className="pointer-events-none absolute top-1/2 left-4 h-[18px] w-[18px] -translate-y-1/2 text-zinc-400 transition group-focus-within:text-brand-600" />
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search products, brands and stores…"
          className="h-12 w-full rounded-2xl border border-zinc-200 bg-zinc-50 pr-24 pl-11 text-sm shadow-inner outline-none transition placeholder:text-zinc-400 focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-500/15 dark:border-white/10 dark:bg-white/[0.04] dark:focus:bg-white/[0.06]"
          aria-label="Search"
          role="combobox"
          aria-expanded={open}
        />
        <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1">
          {isFetching && <Spinner className="h-4 w-4 text-brand-500" />}
          {query && (
            <button type="button" onClick={() => setQuery('')} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-600 dark:hover:bg-white/10" aria-label="Clear search">
              <X className="h-4 w-4" />
            </button>
          )}
          <button type="submit" className="btn btn-primary h-9 rounded-xl px-3.5 py-0" aria-label="Search">
            <Search className="h-4 w-4" />
          </button>
        </div>
      </form>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.99 }}
            transition={{ duration: 0.15 }}
            className="absolute top-[calc(100%+8px)] right-0 left-0 z-50 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl shadow-zinc-900/10 dark:border-white/10 dark:bg-surface-dark"
          >
            {showSuggestions ? (
              options.length ? (
                <ul className="max-h-[60vh] overflow-y-auto p-2">
                  {options.map((opt, i) => (
                    <li key={opt.key}>
                      {opt.type === 'correction' ? (
                        <button
                          type="button"
                          onMouseEnter={() => setActive(i)}
                          onClick={() => go(opt.to, opt.term)}
                          className={cn('mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition', active === i ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-zinc-50 dark:hover:bg-white/5')}
                        >
                          <SpellCheck className="h-4 w-4 shrink-0 text-brand-500" />
                          <span className="min-w-0 flex-1 truncate">
                            <span className="muted">Did you mean: </span>
                            {correctedWords(opt.label)}
                            <span className="muted">?</span>
                          </span>
                        </button>
                      ) : (
                      <button
                        type="button"
                        onMouseEnter={() => setActive(i)}
                        onClick={() => go(opt.to)}
                        className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition', active === i ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-zinc-50 dark:hover:bg-white/5')}
                      >
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-100 dark:bg-white/5">
                          {opt.image ? <img src={opt.image} alt="" className="h-full w-full object-contain p-0.5" /> : <LayoutGrid className="h-4 w-4 text-zinc-400" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate">{highlight(opt.label)}</p>
                          <p className="text-xs muted">{opt.type === 'category' ? 'Category' : money(opt.price)}</p>
                        </div>
                        <ArrowUpRight className="h-4 w-4 text-zinc-300" />
                      </button>
                      )}
                    </li>
                  ))}
                  <li>
                    <button type="button" onClick={submit} className="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold text-brand-600 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-500/10">
                      <Search className="h-4 w-4" /> See all results for “{query.trim()}”
                    </button>
                  </li>
                </ul>
              ) : (
                <div className="p-6 text-center text-sm muted">No matches for “{debounced}”. Press Enter to search anyway.</div>
              )
            ) : (
              <div className="space-y-4 p-4">
                {recent.length > 0 && (
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Recent</p>
                      <button
                        type="button"
                        className="text-xs font-semibold text-zinc-400 hover:text-zinc-600"
                        onClick={() => {
                          localStorage.removeItem(RECENT_KEY);
                          setRecent([]);
                        }}
                      >
                        Clear
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {recent.map((r) => (
                        <button key={r} type="button" className="chip" onClick={() => go(`/search?q=${encodeURIComponent(r)}`, r)}>
                          <Clock className="h-3 w-3" /> {r}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <p className="mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Popular searches</p>
                  <div className="flex flex-wrap gap-2">
                    {POPULAR.map((term) => (
                      <button key={term} type="button" className="chip" onClick={() => go(`/search?q=${encodeURIComponent(term)}`, term)}>
                        {term}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
