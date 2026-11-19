import { useState } from 'react';
import { motion } from 'framer-motion';
import { Star } from 'lucide-react';
import { cn } from '../../lib/format';

/** Read-only stars with fractional fill. */
interface StarsProps {
  value?: number;
  size?: string;
  className?: string;
}

export function Stars({ value = 0, size = 'h-3.5 w-3.5', className }: StarsProps) {
  return (
    <div className={cn('flex items-center gap-0.5', className)} role="img" aria-label={`${value.toFixed(1)} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => {
        const fill = Math.max(0, Math.min(1, value - (i - 1)));
        return (
          <span key={i} className="relative inline-block">
            <Star className={cn(size, 'text-zinc-300 dark:text-zinc-600')} fill="currentColor" strokeWidth={0} />
            <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
              <Star className={cn(size, 'text-amber-400')} fill="currentColor" strokeWidth={0} />
            </span>
          </span>
        );
      })}
    </div>
  );
}

interface RatingPillProps {
  value?: number;
  count?: number;
  className?: string;
}

export function RatingPill({ value, count, className }: RatingPillProps) {
  if (!count) return <span className={cn('text-xs muted', className)}>No ratings yet</span>;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', className)}>
      <span className="inline-flex items-center gap-0.5 rounded-md bg-emerald-600 px-1.5 py-0.5 font-bold text-white">
        {value.toFixed(1)} <Star className="h-3 w-3" fill="currentColor" strokeWidth={0} />
      </span>
      <span className="muted">({count.toLocaleString('en-IN')})</span>
    </span>
  );
}

const LABELS = ['', 'Terrible', 'Poor', 'Okay', 'Good', 'Excellent'];

/** Interactive star input with hover preview. */
interface StarPickerProps {
  value?: number;
  onChange?: (value: number) => void;
  size?: string;
}

export function StarPicker({ value, onChange, size = 'h-8 w-8' }: StarPickerProps) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <div className="flex items-center gap-3">
      <div className="flex gap-1" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((i) => (
          <motion.button
            key={i}
            type="button"
            whileHover={{ scale: 1.15 }}
            whileTap={{ scale: 0.9 }}
            onMouseEnter={() => setHover(i)}
            onClick={() => onChange(i)}
            aria-label={`${i} star${i > 1 ? 's' : ''}`}
          >
            <Star
              className={cn(size, 'transition-colors', i <= shown ? 'text-amber-400' : 'text-zinc-300 dark:text-zinc-600')}
              fill="currentColor"
              strokeWidth={0}
            />
          </motion.button>
        ))}
      </div>
      <span className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">{LABELS[shown]}</span>
    </div>
  );
}
