import { AnimatePresence, motion } from 'framer-motion';
import { Minus, Plus, Trash2 } from 'lucide-react';
import { cn } from '../../lib/format';

interface QuantityStepperProps {
  value?: number;
  max?: number;
  onChange?: (quantity: number) => void;
  size?: string;
  allowRemove?: boolean;
  disabled?: boolean;
}

export default function QuantityStepper({ value, max = 10, onChange, size = 'md', allowRemove = false, disabled = false }: QuantityStepperProps) {
  const dims = size === 'sm' ? 'h-8 w-8' : 'h-10 w-10';
  const showTrash = allowRemove && value <= 1;
  return (
    <div className={cn('inline-flex items-center rounded-xl border border-zinc-200 bg-white dark:border-white/10 dark:bg-white/5', disabled && 'opacity-50')}>
      <button
        type="button"
        disabled={disabled || (!allowRemove && value <= 1)}
        onClick={() => onChange(value - 1)}
        className={cn(dims, 'flex items-center justify-center rounded-l-xl text-zinc-600 transition hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-white/10')}
        aria-label={showTrash ? 'Remove item' : 'Decrease quantity'}
      >
        {showTrash ? <Trash2 className="h-3.5 w-3.5 text-rose-500" /> : <Minus className="h-3.5 w-3.5" />}
      </button>
      <div className={cn('relative flex items-center justify-center overflow-hidden text-sm font-bold tabular-nums', size === 'sm' ? 'w-7' : 'w-9')}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={value} initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -12, opacity: 0 }} transition={{ duration: 0.15 }}>
            {value}
          </motion.span>
        </AnimatePresence>
      </div>
      <button
        type="button"
        disabled={disabled || value >= max}
        onClick={() => onChange(value + 1)}
        className={cn(dims, 'flex items-center justify-center rounded-r-xl text-zinc-600 transition hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-white/10')}
        aria-label="Increase quantity"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
