import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowRight, BadgeCheck, Copy, PackageCheck, Rocket, Star, Store, Timer, TrendingUp, Wallet, Zap,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../lib/api';
import { cn, compactNumber, gradientFor, money } from '../lib/format';
import { readRecentlyViewed, useNow } from '../lib/hooks';
import ProductRail from '../components/product/ProductRail';
import { Segmented } from '../components/ui/Controls';
import { ErrorState, Skeleton } from '../components/ui/Feedback';
import { StoreAvatar } from '../components/ui/Brand';
import { useAuth } from '../store/auth';
import { sellerHome } from '../lib/roles';

const WORDS = ['gadgets', 'fashion', 'beauty', 'home decor', 'groceries'];

function RotatingWord() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setIndex((i) => (i + 1) % WORDS.length), 2200);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="relative inline-flex h-[1.15em] overflow-hidden align-bottom">
      <AnimatePresence mode="popLayout">
        <motion.span
          key={WORDS[index]}
          initial={{ y: '100%', opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: '-100%', opacity: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 24 }}
          className="bg-gradient-to-r from-amber-300 via-orange-300 to-pink-300 bg-clip-text pb-1 text-transparent"
        >
          {WORDS[index]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function Hero({ data }) {
  const user = useAuth((s) => s.user);
  // Sellers and admins get a way back to their console instead of a "Become a seller" invitation.
  const own = sellerHome(user);
  const showcase = data?.trending?.slice(0, 3) || [];
  const tilts = ['-6deg', '4deg', '-2deg'];
  const positions = ['top-4 left-0 sm:left-4', 'top-24 right-0 sm:right-2', 'bottom-0 left-16 sm:left-28'];

  return (
    <section className="container-page pt-6">
      <div className="relative overflow-hidden rounded-[2rem] bg-[#100b2e] px-6 py-12 text-white sm:px-12 lg:py-16">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-24 -left-24 h-96 w-96 animate-blob rounded-full bg-brand-600/50 blur-3xl" />
          <div className="absolute top-20 right-0 h-80 w-80 animate-blob rounded-full bg-fuchsia-500/30 blur-3xl [animation-delay:-4s]" />
          <div className="absolute -bottom-32 left-1/3 h-80 w-80 animate-blob rounded-full bg-amber-400/20 blur-3xl [animation-delay:-8s]" />
          <div className="absolute inset-0 bg-grid opacity-40 [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
        </div>

        <div className="relative grid items-center gap-12 lg:grid-cols-[1.15fr_1fr]">
          <div>
            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="font-display text-4xl leading-[1.08] font-extrabold tracking-tight sm:text-5xl lg:text-6xl"
            >
              Shop <RotatingWord />
              <br />
              from sellers you’ll love.
            </motion.h1>
            <motion.p initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="mt-5 max-w-lg text-base text-indigo-100/80 sm:text-lg">
              One cart, many independent stores. Every order is split securely between sellers and the platform, and sellers get paid when your package arrives.
            </motion.p>
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="mt-8 flex flex-wrap gap-3">
              <Link to="/search" className="btn btn-accent btn-lg">
                Start shopping <ArrowRight className="h-4 w-4" />
              </Link>
              <Link to={own?.to || '/sell'} className="btn btn-lg border border-white/20 bg-white/10 text-white backdrop-blur hover:bg-white/20">
                <Store className="h-4 w-4" /> {own?.label || 'Become a seller'}
              </Link>
            </motion.div>
          </div>

          <div className="relative hidden h-[420px] sm:block">
            {showcase.map((p, i) => (
              <Link
                key={p._id}
                to={`/product/${p._id}`}
                style={{ '--tilt': tilts[i], animationDelay: `${-i * 2}s` }}
                className={cn('absolute w-52 animate-float rounded-3xl bg-white p-3 text-zinc-900 shadow-2xl shadow-black/40 transition hover:z-10 hover:scale-105', positions[i])}
              >
                <div className="aspect-square overflow-hidden rounded-2xl bg-gradient-to-br from-zinc-50 to-zinc-100">
                  <img src={p.thumbnail} alt={p.title} className="h-full w-full object-contain p-3" />
                </div>
                <p className="mt-2 truncate text-sm font-semibold">{p.title}</p>
                <div className="mt-1 flex items-center justify-between">
                  <span className="font-display font-bold">{money(p.price)}</span>
                  {p.discount > 0 && <span className="rounded-md bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-600">−{p.discount}% OFF</span>}
                </div>
              </Link>
            ))}
            {showcase.length > 0 && (
              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.5 }}
                className="absolute right-6 bottom-10 flex items-center gap-2 rounded-2xl bg-white/95 px-3 py-2 text-zinc-900 shadow-xl"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600">
                  <TrendingUp className="h-4 w-4" />
                </div>
                <div className="leading-tight">
                  <p className="text-[11px] text-zinc-500">Sold this month</p>
                  <p className="text-sm font-bold">{compactNumber(showcase.reduce((s, p) => s + p.sold, 0))}+ units</p>
                </div>
              </motion.div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Categories({ categories, loading }) {
  return (
    <section className="container-page">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h2 className="section-title">Shop by category</h2>
          <p className="mt-1 text-sm muted">From flagship phones to fresh groceries</p>
        </div>
        <Link to="/search" className="text-sm font-semibold text-brand-600 dark:text-brand-300">
          Browse all →
        </Link>
      </div>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {loading
          ? Array.from({ length: 16 }, (_, i) => <Skeleton key={i} className="aspect-[4/5]" />)
          : categories.slice(0, 16).map((c, i) => (
              <motion.div key={c._id} initial={{ opacity: 0, scale: 0.9 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true }} transition={{ delay: i * 0.025 }}>
                <Link to={`/search?category=${c._id}`} className="group card flex flex-col items-center gap-2 p-3 text-center transition hover:-translate-y-1 hover:border-brand-200 hover:shadow-lg hover:shadow-brand-900/5 dark:hover:border-brand-400/30">
                  <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-gradient-to-br from-brand-50 to-indigo-50 dark:from-white/[0.04] dark:to-white/[0.02]">
                    <img src={c.image} alt={c.name} loading="lazy" className="h-full w-full object-contain p-2 transition duration-500 group-hover:scale-110 group-hover:rotate-3" />
                  </div>
                  <div>
                    <p className="line-clamp-1 text-xs font-semibold sm:text-[13px]">{c.name}</p>
                    <p className="text-[11px] muted">{c.productCount} items</p>
                  </div>
                </Link>
              </motion.div>
            ))}
      </div>
    </section>
  );
}

function Countdown() {
  const now = useNow();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const diff = Math.max(0, end.getTime() - now);
  const parts = [Math.floor(diff / 3.6e6), Math.floor((diff % 3.6e6) / 6e4), Math.floor((diff % 6e4) / 1000)].map((n) => String(n).padStart(2, '0'));
  return (
    <div className="flex items-center gap-1.5">
      <Timer className="h-4 w-4 text-rose-500" />
      <span className="text-xs font-semibold muted">Ends in</span>
      {parts.map((part, i) => (
        <span key={i} className="flex items-center gap-1.5">
          <span className="relative min-w-[2.1rem] overflow-hidden rounded-lg bg-zinc-900 px-1.5 py-1 text-center font-mono text-sm font-bold text-white dark:bg-white dark:text-zinc-900">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={part} initial={{ y: -14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 14, opacity: 0 }} className="block">
                {part}
              </motion.span>
            </AnimatePresence>
          </span>
          {i < 2 && <span className="font-bold text-zinc-400">:</span>}
        </span>
      ))}
    </div>
  );
}

function Promos({ categories }) {
  // The Tech Fest banner features the Smartphones category (looked up by name; ids differ per database).
  const phones = categories?.find((c) => c.name === 'Smartphones');
  const image = () => phones?.image;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText('WELCOME10');
      toast.success('Code WELCOME10 copied!');
    } catch {
      toast('Use code WELCOME10 at checkout');
    }
  };
  return (
    <section className="container-page grid gap-4 md:grid-cols-3">
      <Link to={phones ? `/search?category=${phones._id}` : '/search?q=smartphone'} className="group relative overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-600 to-brand-700 p-6 text-white md:col-span-2">
        <div className="relative z-10 max-w-xs">
          <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold tracking-wide uppercase">Tech Fest</span>
          <h3 className="mt-3 font-display text-2xl font-bold sm:text-3xl">Flagship phones & laptops, up to 20% off</h3>
          <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold">
            Shop electronics <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
          </span>
        </div>
        {image() && <img src={image()} alt="" className="absolute -right-4 -bottom-6 h-52 object-contain drop-shadow-2xl transition duration-500 group-hover:scale-105 group-hover:-rotate-3 sm:h-60" />}
        <Zap className="absolute top-6 right-6 h-24 w-24 text-white/5" />
      </Link>
      <button type="button" onClick={copy} className="group relative overflow-hidden rounded-3xl bg-gradient-to-br from-amber-300 to-orange-400 p-6 text-left text-zinc-900">
        <span className="rounded-full bg-zinc-900/10 px-2.5 py-1 text-[11px] font-bold tracking-wide uppercase">New here?</span>
        <h3 className="mt-3 font-display text-2xl font-bold">10% off your first order</h3>
        <div className="mt-4 inline-flex items-center gap-2 rounded-xl border-2 border-dashed border-zinc-900/30 bg-white/40 px-3 py-2 font-mono text-sm font-bold">
          WELCOME10 <Copy className="h-4 w-4 transition group-hover:scale-110" />
        </div>
        <p className="mt-2 text-xs font-medium text-zinc-800/80">Tap to copy · min. order ₹999</p>
      </button>
    </section>
  );
}

function TopStores({ stores = [], loading }) {
  return (
    <section className="container-page">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h2 className="section-title">Top stores</h2>
          <p className="mt-1 text-sm muted">Verified sellers loved by thousands of shoppers</p>
        </div>
        <Link to="/stores" className="text-sm font-semibold text-brand-600 dark:text-brand-300">
          All stores →
        </Link>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading
          ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-64" />)
          : stores.slice(0, 8).map((store, i) => <StoreCard key={store._id} store={store} index={i} />)}
      </div>
    </section>
  );
}

export function StoreCard({ store, index = 0 }) {
  return (
    <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: index * 0.05 }}>
      <Link to={`/store/${store._id}`} className="group card block overflow-hidden transition hover:-translate-y-1 hover:shadow-xl hover:shadow-brand-900/5">
        {/* The store's own banner; the name-based gradient only when the store hasn't uploaded one. */}
        <div className={cn('relative h-20 overflow-hidden bg-gradient-to-br', gradientFor(store.storeName))}>
          {store.banner ? (
            <img src={store.banner} alt="" loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
          ) : (
            <div className="absolute inset-0 bg-grid opacity-30" />
          )}
        </div>
        <div className="px-4 pb-4">
          <StoreAvatar store={store} size="h-14 w-14" className="relative z-10 -mt-7 ring-4 ring-white dark:ring-surface-dark" />
          <div className="mt-2 flex items-center gap-1.5">
            <p className="truncate font-semibold group-hover:text-brand-600 dark:group-hover:text-brand-300">{store.storeName}</p>
            <BadgeCheck className="h-4 w-4 shrink-0 text-sky-500" />
          </div>
          <p className="line-clamp-1 text-xs muted">{store.tagline}</p>
          <div className="mt-3 flex items-center gap-3 text-xs">
            <span className="flex items-center gap-1 font-semibold">
              <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" /> {(store.rating || 0).toFixed(1)}
            </span>
            <span className="muted">{store.productCount} products</span>
            <span className="muted">{compactNumber(store.sold)} sold</span>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1.5">
            {(store.previews || []).map((src, i) => (
              <div key={i} className="aspect-square overflow-hidden rounded-lg bg-zinc-50 dark:bg-white/5">
                <img src={src} alt="" loading="lazy" className="h-full w-full object-contain p-1" />
              </div>
            ))}
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

function SellerCta() {
  const steps = [
    { icon: Rocket, title: 'Register your store', text: 'Business & bank details in 3 minutes' },
    { icon: PackageCheck, title: 'List & fulfil orders', text: 'Upload products, ship packages' },
    { icon: Wallet, title: 'Get paid automatically', text: 'Stripe Connect splits every payment' },
  ];
  return (
    <section className="container-page">
      <div className="relative overflow-hidden rounded-[2rem] border border-brand-200/60 bg-gradient-to-br from-brand-50 via-white to-indigo-50 p-8 sm:p-12 dark:border-brand-400/15 dark:from-brand-500/10 dark:via-surface-dark dark:to-indigo-500/5">
        <div className="absolute -top-20 -right-20 h-72 w-72 rounded-full bg-brand-400/20 blur-3xl" />
        <div className="relative grid items-center gap-10 lg:grid-cols-2">
          <div>
            <span className="text-xs font-bold tracking-[0.2em] text-brand-600 uppercase dark:text-brand-300">Sell on Vendora</span>
            <h2 className="mt-3 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">Turn your products into a thriving online store.</h2>
            <p className="mt-3 max-w-md muted">Reach shoppers across India with zero setup cost. You keep up to 95% of every sale, paid out as soon as orders are delivered.</p>
            <Link to="/sell" className="btn btn-primary btn-lg mt-6">
              Start selling <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="space-y-3">
            {steps.map(({ icon: Icon, title, text }, i) => (
              <motion.div
                key={title}
                initial={{ opacity: 0, x: 30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1 }}
                className="card flex items-center gap-4 p-4"
              >
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 text-white shadow-lg shadow-brand-600/30">
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-semibold">
                    <span className="mr-2 text-brand-500">0{i + 1}</span>
                    {title}
                  </p>
                  <p className="text-sm muted">{text}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const user = useAuth((s) => s.user);
  const [tab, setTab] = useState('topRated');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['home'], queryFn: () => api.get('/home').then((r) => r.data) });
  const [recent] = useState(readRecentlyViewed);

  if (error) {
    return (
      <div className="container-page py-16">
        <ErrorState error={error} onRetry={refetch} />
      </div>
    );
  }

  return (
    <div className="space-y-14 pb-6 sm:space-y-16">
      <Hero data={data} />
      <Categories categories={data?.categories || []} loading={isLoading} />

      <div className="relative py-2">
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-rose-50 via-orange-50 to-amber-50 dark:from-rose-500/[0.06] dark:via-orange-500/[0.04] dark:to-amber-500/[0.06]" />
        <ProductRail
          className="py-8"
          title="Deals of the day"
          subtitle="Biggest discounts across the marketplace"
          products={data?.deals}
          loading={isLoading}
          viewAll="/search?sort=discount"
          accessory={<div className="hidden lg:block"><Countdown /></div>}
        />
      </div>

      <ProductRail title="Trending now" subtitle="What shoppers are buying this week" products={data?.trending} loading={isLoading} viewAll="/search?sort=popular" />
      <Promos categories={data?.categories} />
      <TopStores stores={data?.vendors} loading={isLoading} />

      <ProductRail
        title={tab === 'topRated' ? 'Top rated' : 'New arrivals'}
        subtitle={tab === 'topRated' ? 'Highest rated by verified buyers' : 'Fresh drops from our sellers'}
        products={tab === 'topRated' ? data?.topRated : data?.newArrivals}
        loading={isLoading}
        viewAll={tab === 'topRated' ? '/search?sort=rating' : '/search?sort=newest'}
        accessory={
          <Segmented
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'topRated', label: 'Top rated' },
              { value: 'newArrivals', label: 'New' },
            ]}
          />
        }
      />

      {recent.length > 0 && <ProductRail title="Recently viewed" subtitle="Pick up where you left off" products={recent} />}
      {!sellerHome(user) && <SellerCta />}
    </div>
  );
}
