import { Link } from 'react-router-dom';
import { cn, gradientFor, initials } from '../../lib/format';

interface LogoMarkProps {
  className?: string;
}

export function LogoMark({ className }: LogoMarkProps) {
  return (
    <svg viewBox="0 0 64 64" className={cn('h-9 w-9', className)} aria-hidden="true">
      <defs>
        <linearGradient id="vendora-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7458fb" />
          <stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill="url(#vendora-mark)" />
      <path d="M17 20h8.5l6.5 17 6.5-17H47L35.5 46h-7z" fill="#fff" />
      <circle cx="46" cy="44" r="4" fill="#fbbf24" />
    </svg>
  );
}

interface LogoProps {
  to?: string;
  className?: string;
  subtitle?: React.ReactNode;
}

export function Logo({ to = '/', className, subtitle }: LogoProps) {
  return (
    <Link to={to} className={cn('group flex items-center gap-2.5', className)}>
      <LogoMark className="transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-105" />
      <div className="leading-none">
        <span className="font-display text-[1.35rem] font-extrabold tracking-tight text-zinc-900 dark:text-white">vendora</span>
        {subtitle && <span className="mt-0.5 block text-[10px] font-semibold tracking-[0.18em] text-brand-600 uppercase dark:text-brand-300">{subtitle}</span>}
      </div>
    </Link>
  );
}

/** Store logo, or a gradient monogram when the seller hasn't uploaded one. */
interface StoreAvatarProps {
  store?: { storeName?: string; logo?: string; [key: string]: any } | null;
  size?: string;
  rounded?: string;
  className?: string;
}

export function StoreAvatar({ store, size = 'h-12 w-12', rounded = 'rounded-2xl', className }: StoreAvatarProps) {
  if (store?.logo) {
    return <img src={store.logo} alt={store.storeName} className={cn(size, rounded, 'object-cover ring-1 ring-black/5', className)} />;
  }
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center bg-gradient-to-br font-display font-bold text-white shadow-inner',
        gradientFor(store?.storeName),
        size,
        rounded,
        className,
      )}
    >
      {initials(store?.storeName) || 'S'}
    </div>
  );
}

interface UserAvatarProps {
  user?: { name?: string; avatar?: string; [key: string]: any } | null;
  size?: string;
  className?: string;
}

export function UserAvatar({ user, size = 'h-9 w-9', className }: UserAvatarProps) {
  if (user?.avatar) return <img src={user.avatar} alt={user.name} className={cn(size, 'rounded-full object-cover', className)} />;
  return (
    <div className={cn('flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-xs font-bold text-white', gradientFor(user?.name), size, className)}>
      {initials(user?.name) || '?'}
    </div>
  );
}
