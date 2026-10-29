import { ArrowDown, ArrowUp } from 'lucide-react';
import { cn, money } from '../../lib/format';

/** Price rise/drop since the item was added, and a notice when stock caps the requested quantity. */
export default function CartLineNotices({ item, className }) {
  const change = item.priceChanged;
  const dropped = change && change.to < change.from;
  return (
    <>
      {change && (
        <p className={cn('flex items-center gap-1 text-xs font-semibold', dropped ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400', className)}>
          {dropped ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
          Price {dropped ? 'dropped' : 'went up'}: <span className="line-through opacity-70">{money(change.from)}</span> → {money(change.to)}
        </p>
      )}
      {item.inStock && item.limited && (
        <p className={cn('text-xs font-semibold text-amber-600 dark:text-amber-400', className)}>
          Only {item.maxQuantity} available — you asked for {item.requestedQuantity}
        </p>
      )}
    </>
  );
}
