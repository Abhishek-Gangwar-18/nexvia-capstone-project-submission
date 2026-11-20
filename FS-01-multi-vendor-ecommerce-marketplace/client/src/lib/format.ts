import clsx from 'clsx';

export const cn = (...classes) => clsx(classes);

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inrPaise = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const money = (n) => {
  const value = Number(n) || 0;
  return (Number.isInteger(value) ? inr : inrPaise).format(value);
};

export const compactMoney = (n) =>
  `₹${new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n) || 0)}`;

export const number = (n) => new Intl.NumberFormat('en-IN').format(Number(n) || 0);

export const compactNumber = (n) => new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n) || 0);

export const formatDate = (d, options = {}) =>
  new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', ...options });

export const formatDateTime = (d) =>
  new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function timeAgo(d) {
  const seconds = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(-Math.round(seconds / size), unit);
  }
  return 'just now';
}

export const discountOf = (p) => (p?.mrp > p?.price ? Math.round(((p.mrp - p.price) / p.mrp) * 100) : 0);

/** Estimated delivery date, skipping Sundays. */
export function deliveryEstimate(days = 3) {
  const date = new Date();
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    if (date.getDay() !== 0) added += 1;
  }
  return date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

export const initials = (name = '') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

/** Stable gradient per string — used for store monograms and avatars. */
const GRADIENTS = [
  'from-violet-500 to-indigo-600',
  'from-fuchsia-500 to-pink-600',
  'from-amber-400 to-orange-500',
  'from-emerald-400 to-teal-600',
  'from-sky-400 to-blue-600',
  'from-rose-400 to-red-500',
  'from-lime-400 to-green-600',
  'from-cyan-400 to-sky-600',
];
export const gradientFor = (text = '') => {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return GRADIENTS[hash % GRADIENTS.length];
};

/** "1 item", "3 items". */
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
