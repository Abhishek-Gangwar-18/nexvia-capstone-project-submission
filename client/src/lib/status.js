/** Display metadata for every status used across orders, packages, vendors, payments and payouts. */
export const STATUS = {
  // order / package
  pending_payment: { label: 'Awaiting payment', tone: 'amber' },
  pending: { label: 'Pending', tone: 'amber' },
  placed: { label: 'Placed', tone: 'sky' },
  processing: { label: 'Processing', tone: 'violet' },
  packed: { label: 'Packed', tone: 'violet' },
  shipped: { label: 'Shipped', tone: 'indigo' },
  delivered: { label: 'Delivered', tone: 'emerald' },
  cancelled: { label: 'Cancelled', tone: 'rose' },
  payment_failed: { label: 'Payment failed', tone: 'rose' },
  // payment
  paid: { label: 'Paid', tone: 'emerald' },
  failed: { label: 'Failed', tone: 'rose' },
  refunded: { label: 'Refunded', tone: 'zinc' },
  // vendor
  approved: { label: 'Approved', tone: 'emerald' },
  rejected: { label: 'Rejected', tone: 'rose' },
  suspended: { label: 'Suspended', tone: 'zinc' },
  // payouts
  on_hold: { label: 'On hold', tone: 'amber' },
  released: { label: 'Released', tone: 'emerald' },
  reversed: { label: 'Reversed', tone: 'rose' },
  // misc
  active: { label: 'Active', tone: 'emerald' },
  inactive: { label: 'Hidden', tone: 'zinc' },
  blocked: { label: 'Blocked', tone: 'rose' },
};

export const TONES = {
  amber: 'bg-amber-100 text-amber-800 ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/20',
  sky: 'bg-sky-100 text-sky-800 ring-sky-600/20 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-400/20',
  violet: 'bg-violet-100 text-violet-800 ring-violet-600/20 dark:bg-violet-400/10 dark:text-violet-300 dark:ring-violet-400/20',
  indigo: 'bg-indigo-100 text-indigo-800 ring-indigo-600/20 dark:bg-indigo-400/10 dark:text-indigo-300 dark:ring-indigo-400/20',
  emerald: 'bg-emerald-100 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/20',
  rose: 'bg-rose-100 text-rose-800 ring-rose-600/20 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-400/20',
  zinc: 'bg-zinc-100 text-zinc-700 ring-zinc-500/20 dark:bg-white/10 dark:text-zinc-300 dark:ring-white/15',
};

export const DOTS = {
  amber: 'bg-amber-500',
  sky: 'bg-sky-500',
  violet: 'bg-violet-500',
  indigo: 'bg-indigo-500',
  emerald: 'bg-emerald-500',
  rose: 'bg-rose-500',
  zinc: 'bg-zinc-400',
};

export const PACKAGE_FLOW = ['placed', 'packed', 'shipped', 'delivered'];

/** The next action a seller can take on a package. */
export const NEXT_ACTION = {
  placed: { status: 'packed', label: 'Mark as packed' },
  packed: { status: 'shipped', label: 'Mark as shipped' },
  shipped: { status: 'delivered', label: 'Mark as delivered' },
};
