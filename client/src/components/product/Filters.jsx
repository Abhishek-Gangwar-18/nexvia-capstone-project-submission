import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Search, Star } from 'lucide-react';
import { cn, money } from '../../lib/format';
import { Switch } from '../ui/Controls';

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-zinc-200/70 py-4 last:border-0 dark:border-white/[0.06]">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-sm font-semibold">
        {title}
        <ChevronDown className={cn('h-4 w-4 text-zinc-400 transition', open && 'rotate-180')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="pt-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Dual-thumb price slider; commits on release so every drag doesn't trigger a search. */
export function PriceRange({ min, max, value, onCommit }) {
  const [range, setRange] = useState([value[0] ?? min, value[1] ?? max]);
  useEffect(() => setRange([value[0] ?? min, value[1] ?? max]), [value[0], value[1], min, max]); // eslint-disable-line react-hooks/exhaustive-deps

  const span = Math.max(1, max - min);
  const pct = (v) => ((v - min) / span) * 100;
  const step = Math.max(1, Math.round(span / 200));
  const commit = () => onCommit(range[0] <= min ? undefined : range[0], range[1] >= max ? undefined : range[1]);
  const thumb =
    'pointer-events-none absolute inset-0 h-1.5 w-full appearance-none bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:shadow-md [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-brand-500 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md';

  if (max <= min) return <p className="text-xs muted">All results are priced {money(min)}</p>;

  return (
    <div>
      <div className="relative mx-2 mt-2 mb-5 h-1.5 rounded-full bg-zinc-200 dark:bg-white/10">
        <div className="absolute h-full rounded-full bg-gradient-to-r from-brand-500 to-indigo-500" style={{ left: `${pct(range[0])}%`, right: `${100 - pct(range[1])}%` }} />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={range[0]}
          onChange={(e) => setRange([Math.min(Number(e.target.value), range[1] - step), range[1]])}
          onMouseUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          className={thumb}
          aria-label="Minimum price"
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={range[1]}
          onChange={(e) => setRange([range[0], Math.max(Number(e.target.value), range[0] + step)])}
          onMouseUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          className={thumb}
          aria-label="Maximum price"
        />
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="flex-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 font-semibold dark:border-white/10">{money(range[0])}</span>
        <span className="text-zinc-400">—</span>
        <span className="flex-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-right font-semibold dark:border-white/10">{money(range[1])}</span>
      </div>
    </div>
  );
}

function CheckRow({ checked, label, count, onClick, radio }) {
  return (
    <button type="button" onClick={onClick} className="group flex w-full items-center gap-2.5 rounded-lg px-1 py-1.5 text-left text-sm transition hover:bg-zinc-50 dark:hover:bg-white/5">
      <span
        className={cn(
          'flex h-[18px] w-[18px] shrink-0 items-center justify-center border-2 transition',
          radio ? 'rounded-full' : 'rounded-md',
          checked ? 'border-brand-600 bg-brand-600 text-white' : 'border-zinc-300 group-hover:border-brand-400 dark:border-white/20',
        )}
      >
        {checked && (radio ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : <Check className="h-3 w-3" strokeWidth={3} />)}
      </span>
      <span className={cn('flex-1 truncate', checked && 'font-semibold')}>{label}</span>
      {count !== undefined && <span className="text-xs text-zinc-400 tabular-nums">{count}</span>}
    </button>
  );
}

export default function Filters({ filters, facets, priceBounds, categoryName, onChange }) {
  const [brandQuery, setBrandQuery] = useState('');
  const [showAllCats, setShowAllCats] = useState(false);
  const brands = useMemo(
    () => (facets?.brands || []).filter((b) => b.key.toLowerCase().includes(brandQuery.toLowerCase())),
    [facets, brandQuery],
  );
  const categories = facets?.categories || [];
  const visibleCats = showAllCats ? categories : categories.slice(0, 8);

  const toggleBrand = (brand) => {
    const next = filters.brands.includes(brand) ? filters.brands.filter((b) => b !== brand) : [...filters.brands, brand];
    onChange({ brand: next.join(',') || undefined });
  };

  return (
    <div>
      <Section title="Category">
        <div className="space-y-0.5">
          <CheckRow radio checked={!filters.category} label="All categories" onClick={() => onChange({ category: undefined, brand: undefined })} />
          {visibleCats.map((c) => (
            <CheckRow key={c.key} radio checked={filters.category === c.key} label={categoryName(c.key)} count={c.count} onClick={() => onChange({ category: c.key, brand: undefined })} />
          ))}
          {categories.length > 8 && (
            <button type="button" onClick={() => setShowAllCats((v) => !v)} className="px-1 pt-1 text-xs font-semibold text-brand-600 dark:text-brand-300">
              {showAllCats ? 'Show less' : `Show all ${categories.length}`}
            </button>
          )}
        </div>
      </Section>

      <Section title="Price">
        <PriceRange min={priceBounds.min} max={priceBounds.max} value={[filters.minPrice, filters.maxPrice]} onCommit={(minPrice, maxPrice) => onChange({ minPrice, maxPrice })} />
      </Section>

      {facets?.brands?.length > 0 && (
        <Section title="Brand">
          {facets.brands.length > 6 && (
            <div className="relative mb-2">
              <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <input value={brandQuery} onChange={(e) => setBrandQuery(e.target.value)} placeholder="Search brands" className="input py-1.5 pl-8 text-xs" />
            </div>
          )}
          <div className="max-h-56 space-y-0.5 overflow-y-auto pr-1">
            {brands.map((b) => (
              <CheckRow key={b.key} checked={filters.brands.includes(b.key)} label={b.key} count={b.count} onClick={() => toggleBrand(b.key)} />
            ))}
            {!brands.length && <p className="px-1 text-xs muted">No brands match</p>}
          </div>
        </Section>
      )}

      <Section title="Customer rating">
        <div className="space-y-0.5">
          {[4, 3, 2].map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onChange({ rating: filters.rating === r ? undefined : r })}
              className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition', filters.rating === r ? 'bg-amber-50 font-semibold text-amber-800 dark:bg-amber-400/10 dark:text-amber-300' : 'hover:bg-zinc-50 dark:hover:bg-white/5')}
            >
              <span className="flex">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Star key={i} className={cn('h-3.5 w-3.5', i <= r ? 'fill-amber-400 text-amber-400' : 'text-zinc-300 dark:text-zinc-600')} />
                ))}
              </span>
              & up
            </button>
          ))}
        </div>
      </Section>

      <Section title="Availability">
        <label className="flex cursor-pointer items-center justify-between text-sm">
          In stock only
          <Switch checked={filters.inStock} onChange={(v) => onChange({ inStock: v ? '1' : undefined })} label="In stock only" />
        </label>
      </Section>
    </div>
  );
}
