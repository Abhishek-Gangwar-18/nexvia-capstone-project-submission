import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ExternalLink, LogOut, Menu, X } from 'lucide-react';
import { useAuth } from '../../store/auth';
import { logout } from '../../lib/session';
import { cn } from '../../lib/format';
import { Logo, StoreAvatar } from '../ui/Brand';
import StatusBadge from '../ui/StatusBadge';
import { AccountMenu, ThemeToggle } from './Navbar';

/** Sidebar shell shared by the seller dashboard and the admin console. */
export default function DashboardLayout({ nav, title, variant }) {
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [location.pathname]);

  const signOut = async () => {
    await logout();
    navigate('/');
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-[68px] items-center px-5">
        <Logo to={variant === 'admin' ? '/admin' : '/vendor'} subtitle={title} />
      </div>
      {variant === 'vendor' && user?.vendor && (
        <div className="mx-4 mb-3 flex items-center gap-3 rounded-2xl border border-zinc-200/70 bg-zinc-50 p-3 dark:border-white/5 dark:bg-white/[0.03]">
          <StoreAvatar store={user.vendor} size="h-10 w-10" rounded="rounded-xl" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{user.vendor.storeName}</p>
            <StatusBadge status={user.vendor.status} className="mt-1" />
          </div>
        </div>
      )}
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {nav.map(({ to, label, icon: Icon, end, badge }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                isActive ? 'text-brand-700 dark:text-white' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white',
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId={`nav-${variant}`}
                    className="absolute inset-0 rounded-xl bg-gradient-to-r from-brand-100 to-indigo-50 ring-1 ring-brand-200/60 dark:from-brand-500/20 dark:to-indigo-500/10 dark:ring-brand-400/20"
                    transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                  />
                )}
                <Icon className={cn('relative h-[18px] w-[18px]', isActive ? 'text-brand-600 dark:text-brand-300' : 'text-zinc-400 group-hover:text-zinc-600')} />
                <span className="relative">{label}</span>
                {badge ? <span className="relative ml-auto rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-zinc-900">{badge}</span> : null}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="space-y-1 border-t border-zinc-200/70 p-3 dark:border-white/5">
        <Link to="/" className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-white/5">
          <ExternalLink className="h-[18px] w-[18px] text-zinc-400" /> Visit marketplace
        </Link>
        <button type="button" onClick={signOut} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10">
          <LogOut className="h-[18px] w-[18px]" /> Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen lg:pl-72">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-72 border-r border-zinc-200/70 bg-white lg:block dark:border-white/[0.06] dark:bg-surface-dark">{sidebar}</aside>

      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.div className="absolute inset-0 bg-zinc-950/50 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(false)} />
            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="absolute inset-y-0 left-0 w-72 bg-white dark:bg-surface-dark"
            >
              <button type="button" onClick={() => setOpen(false)} className="btn-icon absolute top-3.5 right-3" aria-label="Close menu">
                <X className="h-5 w-5" />
              </button>
              {sidebar}
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      <header className="glass sticky top-0 z-30 flex h-[68px] items-center gap-3 border-b px-4 sm:px-6 lg:px-8">
        <button type="button" className="btn-icon -ml-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </button>
        <p className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">{title}</p>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          {user && <AccountMenu user={user} />}
        </div>
      </header>

      <main className="px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <Outlet />
      </main>
    </div>
  );
}

export function PageHeader({ title, description, actions, children }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {description && <p className="mt-1 text-sm muted">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
