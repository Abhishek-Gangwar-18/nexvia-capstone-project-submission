import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronDown, Heart, LayoutDashboard, LogOut, Menu, Moon, Package, Search, Shield, ShoppingBag, Store, Sun, User, X,
} from 'lucide-react';
import { useAuth } from '../../store/auth';
import { useAuthModal } from '../../store/authModal';
import { useCartStore } from '../../store/cart';
import { useTheme } from '../../store/theme';
import { useCart } from '../../lib/cart';
import { useCategories, useClickOutside } from '../../lib/hooks';
import { logout } from '../../lib/session';
import { cn, plural } from '../../lib/format';
import { Logo, UserAvatar } from '../ui/Brand';
import SearchBar from './SearchBar';

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, toggle } = useTheme();
  return (
    <button type="button" onClick={toggle} className={cn('btn-icon', className)} aria-label="Toggle dark mode">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={theme} initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: 90, opacity: 0 }} transition={{ duration: 0.2 }}>
          {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

function CartButton() {
  const { summary } = useCart();
  const openDrawer = useCartStore((s) => s.openDrawer);
  const count = summary.itemCount;
  return (
    <button type="button" onClick={openDrawer} className="btn-icon relative" aria-label={`Cart, ${plural(count, 'item')}`}>
      <ShoppingBag className="h-5 w-5" />
      <AnimatePresence>
        {count > 0 && (
          <motion.span
            key={count}
            initial={{ scale: 0.4 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            transition={{ type: 'spring', stiffness: 600, damping: 15 }}
            className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-gradient-to-r from-amber-400 to-orange-500 px-1 text-[11px] font-bold text-zinc-950 ring-2 ring-white dark:ring-canvas-dark"
          >
            {count > 99 ? '99+' : count}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

/** Wishlist link with the number of saved products (same badge as the cart). */
function WishlistLink() {
  const count = useAuth((s) => s.user?.wishlist?.length || 0);
  return (
    <Link to="/account?tab=wishlist" className="btn-icon relative hidden sm:inline-flex" aria-label={`Wishlist, ${plural(count, 'item')}`}>
      <Heart className="h-5 w-5" />
      <AnimatePresence>
        {count > 0 && (
          <motion.span
            key={count}
            initial={{ scale: 0.4 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            transition={{ type: 'spring', stiffness: 600, damping: 15 }}
            className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[11px] font-bold text-white ring-2 ring-white dark:ring-canvas-dark"
          >
            {count > 99 ? '99+' : count}
          </motion.span>
        )}
      </AnimatePresence>
    </Link>
  );
}

/** Profile dropdown, shared by the marketplace navbar and the seller/admin dashboards. */
interface AccountMenuProps {
  user?: any;
}

export function AccountMenu({ user }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const close = useCallback(() => setOpen(false), []);
  const ref = useClickOutside(close);

  const links = {
    customer: [
      { to: '/orders', label: 'My orders', icon: Package },
      { to: '/account?tab=wishlist', label: 'Wishlist', icon: Heart },
      { to: '/account', label: 'Account settings', icon: User },
      { to: '/sell', label: 'Become a seller', icon: Store },
    ],
    vendor: [
      { to: '/vendor', label: 'Seller dashboard', icon: LayoutDashboard },
      { to: '/vendor/products', label: 'My products', icon: Package },
      { to: '/', label: 'Visit marketplace', icon: Store },
      { to: '/account', label: 'Account settings', icon: User },
    ],
    admin: [
      { to: '/admin', label: 'Admin console', icon: Shield },
      { to: '/', label: 'Visit marketplace', icon: Store },
      { to: '/account', label: 'Account settings', icon: User },
    ],
  }[user.role];

  const signOut = async () => {
    close();
    await logout();
    navigate('/');
  };

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-2xl py-1 pr-2 pl-1 transition hover:bg-zinc-100 dark:hover:bg-white/10">
        <UserAvatar user={user} className="h-8 w-8" />
        <div className="hidden text-left leading-tight lg:block">
          <p className="text-[11px] muted">Hello,</p>
          <p className="max-w-[110px] truncate text-sm font-semibold">{user.name.split(' ')[0]}</p>
        </div>
        <ChevronDown className={cn('hidden h-4 w-4 text-zinc-400 transition lg:block', open && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 z-50 mt-2 w-64 origin-top-right overflow-hidden rounded-2xl border border-zinc-200 bg-white p-2 shadow-2xl shadow-zinc-900/10 dark:border-white/10 dark:bg-surface-dark"
          >
            <div className="flex items-center gap-3 rounded-xl bg-gradient-to-br from-brand-50 to-indigo-50 p-3 dark:from-brand-500/10 dark:to-indigo-500/5">
              <UserAvatar user={user} className="h-10 w-10" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{user.name}</p>
                <p className="truncate text-xs muted">{user.email}</p>
                <span className="mt-1 inline-block rounded-md bg-white/80 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-brand-700 uppercase dark:bg-white/10 dark:text-brand-200">
                  {user.role}
                </span>
              </div>
            </div>
            <div className="my-2 space-y-0.5">
              {links.map(({ to, label, icon: Icon }) => (
                <Link key={to} to={to} onClick={close} className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-white/5">
                  <Icon className="h-4 w-4 text-zinc-400" /> {label}
                </Link>
              ))}
            </div>
            <button type="button" onClick={signOut} className="flex w-full items-center gap-3 rounded-xl border-t border-zinc-100 px-3 py-2.5 text-sm font-medium text-rose-600 transition hover:bg-rose-50 dark:border-white/5 dark:hover:bg-rose-500/10">
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CategoryStrip() {
  const { data: categories = [] } = useCategories();
  return (
    <div className="hidden border-t border-zinc-200/70 md:block dark:border-white/[0.06]">
      <div className="container-page flex items-center gap-1 overflow-x-auto py-1.5 scrollbar-none">
        <NavLink
          to="/search"
          end
          className={({ isActive }) => cn('shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition', isActive ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white')}
        >
          All products
        </NavLink>
        {categories.map((c) => (
          <Link
            key={c._id}
            to={`/search?category=${c._id}`}
            className="shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white"
          >
            {c.name}
          </Link>
        ))}
        <Link to="/stores" className="ml-auto shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-semibold text-brand-600 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-500/10">
          Browse stores →
        </Link>
      </div>
    </div>
  );
}

export default function Navbar() {
  const user = useAuth((s) => s.user);
  const location = useLocation();
  const openAuth = useAuthModal((s) => s.open);
  const [mobileSearch, setMobileSearch] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    setMobileMenu(false);
    setMobileSearch(false);
  }, [location.pathname, location.search]);

  const canShop = !user || user.role === 'customer';

  return (
    <header className={cn('glass sticky top-0 z-40 border-b transition-shadow', scrolled && 'shadow-lg shadow-zinc-900/[0.03]')}>

      <div className="container-page flex h-[68px] items-center gap-3 sm:gap-6">
        <button type="button" className="btn-icon -ml-2 md:hidden" onClick={() => setMobileMenu(true)} aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </button>
        <Logo />
        <SearchBar className="hidden max-w-2xl flex-1 md:block" />
        <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
          <button type="button" className="btn-icon md:hidden" onClick={() => setMobileSearch((v) => !v)} aria-label="Search">
            {mobileSearch ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}
          </button>
          <ThemeToggle />
          {user?.role === 'customer' && <WishlistLink />}
          {canShop && <CartButton />}
          {user ? (
            <AccountMenu user={user} />
          ) : (
            <div className="flex items-center gap-1.5 pl-1">
              <button type="button" onClick={() => openAuth('login')} className="btn btn-ghost hidden sm:inline-flex">
                Sign in
              </button>
              <button type="button" onClick={() => openAuth('register')} className="btn btn-primary px-3.5 sm:px-4">
                Join
              </button>
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {mobileSearch && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-visible md:hidden">
            <div className="container-page pb-3">
              <SearchBar autoFocus onDone={() => setMobileSearch(false)} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Shopping categories don't belong on the account pages (profile, addresses, wishlist, security). */}
      {!location.pathname.startsWith('/account') && <CategoryStrip />}

      <AnimatePresence>
        {mobileMenu && <MobileMenu user={user} onClose={() => setMobileMenu(false)} />}
      </AnimatePresence>
    </header>
  );
}

interface MobileMenuProps {
  user?: any;
  onClose?: () => void;
}

function MobileMenu({ user, onClose }: MobileMenuProps) {
  const { data: categories = [] } = useCategories();
  const openAuth = useAuthModal((s) => s.open);
  return (
    <div className="fixed inset-0 z-[70] md:hidden">
      <motion.div className="absolute inset-0 bg-zinc-950/50 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.aside
        initial={{ x: '-100%' }}
        animate={{ x: 0 }}
        exit={{ x: '-100%' }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        className="absolute inset-y-0 left-0 flex w-[85%] max-w-sm flex-col bg-white dark:bg-surface-dark"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 p-4 dark:border-white/5">
          <Logo />
          <button type="button" onClick={onClose} className="btn-icon" aria-label="Close menu">
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto p-3">
          {!user && (
            <div className="mb-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => { onClose(); openAuth('login'); }} className="btn btn-secondary">Sign in</button>
              <button type="button" onClick={() => { onClose(); openAuth('register'); }} className="btn btn-primary">Create account</button>
            </div>
          )}
          <p className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Shop by category</p>
          <Link to="/search" className="block rounded-xl px-3 py-2.5 text-sm font-semibold hover:bg-zinc-100 dark:hover:bg-white/5">All products</Link>
          <Link to="/stores" className="block rounded-xl px-3 py-2.5 text-sm font-semibold hover:bg-zinc-100 dark:hover:bg-white/5">All stores</Link>
          {categories.map((c) => (
            <Link key={c._id} to={`/search?category=${c._id}`} className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-white/5">
              <img src={c.image} alt="" className="h-8 w-8 rounded-lg bg-zinc-100 object-contain dark:bg-white/5" />
              {c.name}
            </Link>
          ))}
        </nav>
      </motion.aside>
    </div>
  );
}
