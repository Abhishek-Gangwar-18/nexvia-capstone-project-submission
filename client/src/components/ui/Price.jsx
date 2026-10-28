import { cn, discountOf, money } from '../../lib/format';

export default function Price({ price, mrp, size = 'md', className }) {
  const discount = discountOf({ price, mrp });
  const sizes = {
    sm: ['text-base', 'text-xs'],
    md: ['text-lg', 'text-sm'],
    lg: ['text-3xl sm:text-4xl', 'text-base'],
  };
  const [main, sub] = sizes[size];
  return (
    <div className={cn('flex flex-wrap items-baseline gap-x-2 gap-y-0.5', className)}>
      <span className={cn('font-display font-bold tracking-tight text-zinc-900 dark:text-white', main)}>{money(price)}</span>
      {discount > 0 && (
        <>
          <span className={cn('text-zinc-400 line-through', sub)}>{money(mrp)}</span>
          <span className={cn('font-bold text-emerald-600 dark:text-emerald-400', sub)}>{discount}% off</span>
        </>
      )}
    </div>
  );
}
