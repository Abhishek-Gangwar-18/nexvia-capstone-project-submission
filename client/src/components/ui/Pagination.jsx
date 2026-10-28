import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/format';

function pageList(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const list = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(pages - 1, page + 1);
  if (start > 2) list.push('…');
  for (let i = start; i <= end; i++) list.push(i);
  if (end < pages - 1) list.push('…');
  list.push(pages);
  return list;
}

export default function Pagination({ page, pages, onChange, className }) {
  if (!pages || pages <= 1) return null;
  return (
    <nav className={cn('flex items-center justify-center gap-1.5', className)} aria-label="Pagination">
      <button type="button" className="btn-icon h-9 w-9" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page">
        <ChevronLeft className="h-4 w-4" />
      </button>
      {pageList(page, pages).map((p, i) =>
        p === '…' ? (
          <span key={`gap-${i}`} className="px-1 text-zinc-400">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            className={cn(
              'h-9 min-w-9 rounded-xl px-3 text-sm font-semibold transition',
              p === page
                ? 'bg-gradient-to-r from-brand-600 to-indigo-600 text-white shadow-md shadow-brand-600/30'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-white/10',
            )}
          >
            {p}
          </button>
        ),
      )}
      <button type="button" className="btn-icon h-9 w-9" disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="Next page">
        <ChevronRight className="h-4 w-4" />
      </button>
    </nav>
  );
}
