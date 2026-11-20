import type * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/format';
import ProductCard, { ProductCardSkeleton } from './ProductCard';

/** Horizontally scrolling product row with snap points and arrow controls. */
interface ProductRailProps {
  title?: React.ReactNode;
  subtitle?: any;
  products?: any;
  loading?: boolean;
  viewAll?: any;
  accessory?: any;
  className?: string;
}

export default function ProductRail({ title, subtitle, products = [], loading, viewAll, accessory, className }: ProductRailProps) {
  const scroller = useRef(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const update = () => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 8 });
  };
  useEffect(update, [products.length]);

  const scrollBy = (direction) => {
    const el = scroller.current;
    el.scrollBy({ left: direction * el.clientWidth * 0.85, behavior: 'smooth' });
  };

  if (!loading && !products.length) return null;

  return (
    <section className={cn('container-page', className)}>
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h2 className="section-title">{title}</h2>
          {subtitle && <p className="mt-1 text-sm muted">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {accessory}
          {viewAll && (
            <Link to={viewAll} className="hidden items-center gap-1 text-sm font-semibold text-brand-600 hover:gap-2 sm:flex dark:text-brand-300" style={{ transition: 'gap .2s' }}>
              View all <ArrowRight className="h-4 w-4" />
            </Link>
          )}
          <div className="hidden gap-1.5 md:flex">
            <button type="button" onClick={() => scrollBy(-1)} disabled={edges.start} className="btn-icon h-9 w-9 border border-zinc-200 disabled:opacity-30 dark:border-white/10" aria-label="Scroll left">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => scrollBy(1)} disabled={edges.end} className="btn-icon h-9 w-9 border border-zinc-200 disabled:opacity-30 dark:border-white/10" aria-label="Scroll right">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
      <div ref={scroller} onScroll={update} data-wheel="page" className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 scrollbar-none sm:gap-4">
        {(loading ? Array.from({ length: 6 }) : products).map((p, i) => (
          <div key={p?._id || i} className="w-[46%] shrink-0 snap-start sm:w-[31%] lg:w-[23.5%] xl:w-[19%]">
            {loading ? <ProductCardSkeleton /> : <ProductCard product={p} index={i} />}
          </div>
        ))}
      </div>
    </section>
  );
}
