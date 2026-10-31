import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import NotFound from './NotFound';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BadgeCheck, Check, ChevronRight, Package, RotateCcw, Share2, ShieldCheck, ShoppingBag, Star, Store, Truck, Zap,
} from 'lucide-react';
import { api } from '../lib/api';
import { cn, compactNumber, discountOf, money } from '../lib/format';
import { rememberProduct } from '../lib/hooks';
import { useCart, useCartActions } from '../lib/cart';
import Price from '../components/ui/Price';
import { Stars } from '../components/ui/Rating';
import QuantityStepper from '../components/ui/QuantityStepper';
import { Segmented } from '../components/ui/Controls';
import { ErrorState, PageLoader } from '../components/ui/Feedback';
import { StoreAvatar } from '../components/ui/Brand';
import { WishlistButton } from '../components/product/ProductCard';
import ShareModal from '../components/product/ShareModal';
import StaffProductActions from '../components/product/StaffProductActions';
import { useAuth } from '../store/auth';
import { canShop } from '../lib/roles';
import ProductRail from '../components/product/ProductRail';
import Reviews from '../components/product/Reviews';

/** Image gallery with hover magnifier and thumbnail strip. */
function Gallery({ images, title, discount }) {
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState({ on: false, x: 50, y: 50 });
  const src = images[active]?.url;

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setZoom({ on: true, x: ((e.clientX - rect.left) / rect.width) * 100, y: ((e.clientY - rect.top) / rect.height) * 100 });
  };

  return (
    <div className="flex min-w-0 flex-col-reverse gap-3 sm:flex-row sm:items-start">
      <div className="flex gap-2 overflow-x-auto scrollbar-none sm:max-h-[520px] sm:flex-col sm:overflow-y-auto">
        {images.map((img, i) => (
          <button
            key={img.url}
            type="button"
            onMouseEnter={() => setActive(i)}
            onClick={() => setActive(i)}
            className={cn(
              'h-16 w-16 shrink-0 overflow-hidden rounded-xl border-2 bg-white transition sm:h-20 sm:w-20 dark:bg-white/5',
              i === active ? 'border-brand-500 shadow-md shadow-brand-500/20' : 'border-transparent opacity-70 hover:opacity-100',
            )}
          >
            <img src={img.url} alt="" className="h-full w-full object-contain p-1" />
          </button>
        ))}
      </div>
      <div
        className="card relative aspect-square w-full min-w-0 flex-1 cursor-zoom-in self-start overflow-hidden"
        onMouseMove={onMove}
        onMouseLeave={() => setZoom((z) => ({ ...z, on: false }))}
      >
        <AnimatePresence mode="wait">
          <motion.img
            key={src}
            src={src}
            alt={title}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: zoom.on ? 0 : 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="h-full w-full object-contain p-8"
          />
        </AnimatePresence>
        <div
          className="pointer-events-none absolute inset-0 hidden transition-opacity duration-150 md:block"
          style={{ opacity: zoom.on ? 1 : 0, backgroundImage: `url(${src})`, backgroundSize: '220%', backgroundPosition: `${zoom.x}% ${zoom.y}%`, backgroundRepeat: 'no-repeat' }}
        />
        {discount >= 5 && <span className="absolute top-4 left-4 rounded-xl bg-gradient-to-r from-rose-500 to-orange-500 px-2.5 py-1 text-xs font-bold text-white shadow-lg">−{discount}% OFF</span>}
        <span className="absolute right-4 bottom-4 hidden rounded-lg bg-zinc-900/70 px-2 py-1 text-[11px] font-medium text-white backdrop-blur md:block">Hover to zoom</span>
      </div>
    </div>
  );
}

export default function ProductDetail() {
  const { productId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { add, update } = useCartActions();
  const { items: cartItems } = useCart();
  const user = useAuth((s) => s.user);
  // Only guests and customers buy; vendors and admins get their own actions instead.
  const shopper = canShop(user);
  const [tab, setTab] = useState('description');
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['product', productId],
    queryFn: () => api.get(`/products/${productId}`).then((r) => r.data),
    // Stock and price change while the page is open: re-check on return to the tab or page.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const product = data?.product;

  useEffect(() => {
    if (product && location.hash === '#reviews') {
      const timer = setTimeout(() => document.getElementById('reviews')?.scrollIntoView({ behavior: 'smooth' }), 300);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [product, location.hash]);

  useEffect(() => {
    if (product) {
      document.title = `${product.title} · Vendora`;
      rememberProduct({
        _id: product._id, title: product.title, thumbnail: product.thumbnail, price: product.price, mrp: product.mrp,
        rating: product.rating, numRatings: product.numRatings, stock: product.stock, storeName: product.vendor?.storeName, vendorId: product.vendor?._id,
      });
    }
    return () => {
      document.title = 'Vendora — Multi-vendor marketplace';
    };
  }, [product]);

  if (isLoading) return <PageLoader />;
  if (error?.response?.status === 404) return <NotFound title="Product not available" message="This product doesn’t exist or is no longer available." />;
  if (error) {
    return (
      <div className="container-page py-16">
        <ErrorState error={error} onRetry={refetch} />
      </div>
    );
  }

  const discount = discountOf(product);
  const outOfStock = product.stock <= 0;
  const cardProduct = { ...product, vendorId: product.vendor?._id, storeName: product.vendor?.storeName };

  // The cart line for this product: once it exists, "Add to cart" turns into its quantity stepper.
  const inCart = cartItems.find((i) => i.productId === product._id);
  const maxQuantity = Math.min(10, inCart?.maxQuantity ?? product.stock);

  const addToCart = async (buyNow = false) => {
    if (buyNow && inCart) return navigate('/cart');
    setAdding(true);
    const ok = await add(cardProduct, 1, { silent: buyNow });
    setAdding(false);
    if (ok && buyNow) navigate('/cart');
    return undefined;
  };

  /** Quantity 0 removes the line, which brings "Add to cart" back. */
  const changeQuantity = async (quantity) => {
    setAdding(true);
    await update(product._id, quantity);
    setAdding(false);
  };

  const cartControl = (compact = false) =>
    inCart ? (
      <div className={cn('flex items-center justify-center', !compact && 'flex-1')}>
        <QuantityStepper value={inCart.quantity} max={maxQuantity} allowRemove disabled={adding} onChange={changeQuantity} size={compact ? 'sm' : 'md'} />
      </div>
    ) : (
      <button type="button" onClick={() => addToCart(false)} disabled={adding} className={cn('btn btn-secondary', !compact && 'btn-lg flex-1')}>
        {compact ? <Package className="h-4 w-4" /> : <ShoppingBag className="h-4 w-4" />} {compact ? 'Add' : 'Add to cart'}
      </button>
    );

  const share = () => setSharing(true);

  return (
    <div className="pb-24 lg:pb-6">
      <div className="container-page py-6">
        <nav className="mb-5 flex flex-wrap items-center gap-1 text-xs muted">
          <Link to="/" className="hover:text-brand-600">Home</Link>
          <ChevronRight className="h-3 w-3" />
          <Link to={`/search?category=${product.category}`} className="hover:text-brand-600">{data.category?.name || 'Category'}</Link>
          <ChevronRight className="h-3 w-3" />
          <span className="line-clamp-1 text-zinc-700 dark:text-zinc-300">{product.title}</span>
        </nav>

        {/* minmax(0, …): a long title or the pincode form can't widen a column past the page. */}
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:gap-12">
          <Gallery images={product.images.length ? product.images : [{ url: product.thumbnail }]} title={product.title} discount={discount} />

          <div className="min-w-0">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Link to={`/search?brand=${encodeURIComponent(product.brand)}`} className="text-sm font-semibold text-brand-600 hover:underline dark:text-brand-300">
                  {product.brand}
                </Link>
                <h1 className="mt-1 font-display text-2xl leading-tight font-bold tracking-tight sm:text-3xl">{product.title}</h1>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button type="button" onClick={share} className="btn-icon border border-zinc-200 dark:border-white/10" aria-label="Share">
                  <Share2 className="h-4 w-4" />
                </button>
                <WishlistButton productId={product._id} className="h-10 w-10 shadow-none" />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              <a href="#reviews" className="flex items-center gap-1.5 hover:underline">
                <Stars value={product.rating} />
                <span className="font-semibold">{product.rating.toFixed(1)}</span>
                <span className="muted">({product.numRatings} ratings)</span>
              </a>
              <span className="h-4 w-px bg-zinc-200 dark:bg-white/10" />
              <span className="flex items-center gap-1 muted">
                <Zap className="h-3.5 w-3.5 text-amber-500" /> {compactNumber(product.sold)} sold
              </span>
            </div>

            <div className="mt-5 rounded-2xl bg-gradient-to-br from-zinc-50 to-white p-5 ring-1 ring-zinc-200/70 dark:from-white/[0.04] dark:to-transparent dark:ring-white/10">
              <Price price={product.price} mrp={product.mrp} size="lg" />
              <p className="mt-1 text-xs muted">Inclusive of all taxes{discount > 0 && ` · You save ${money(product.mrp - product.price)}`}</p>
              <div className="mt-3">
                {outOfStock ? (
                  <span className="font-semibold text-rose-600">Currently out of stock</span>
                ) : product.stock <= 10 ? (
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-orange-600">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
                      <span className="relative h-2 w-2 rounded-full bg-orange-500" />
                    </span>
                    Hurry, only {product.stock} left in stock
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-emerald-600">
                    <Check className="h-4 w-4" /> In stock
                  </span>
                )}
              </div>

              {!shopper && <StaffProductActions user={user} product={product} />}
              {shopper && !outOfStock && (
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  {cartControl()}
                  <button type="button" onClick={() => addToCart(true)} disabled={adding} className="btn btn-accent btn-lg flex-1">
                    {inCart ? 'Go to cart' : 'Buy now'}
                  </button>
                </div>
              )}
            </div>

            <div className="mt-5 space-y-5">

              <Link to={`/store/${product.vendor._id}`} className="group flex items-center gap-4 rounded-2xl border border-zinc-200 p-4 transition hover:border-brand-300 hover:bg-brand-50/30 dark:border-white/10 dark:hover:bg-brand-500/5">
                <StoreAvatar store={product.vendor} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs muted">Sold & shipped by</p>
                  <p className="flex items-center gap-1 font-semibold">
                    {product.vendor.storeName} <BadgeCheck className="h-4 w-4 text-sky-500" />
                  </p>
                  <p className="mt-0.5 flex items-center gap-3 text-xs muted">
                    <span className="flex items-center gap-1">
                      <Star className="h-3 w-3 fill-amber-400 text-amber-400" /> {data.store?.rating?.toFixed(1) || '—'}
                    </span>
                    <span>{data.store?.products || 0} products</span>
                    <span>{compactNumber(data.store?.sold || 0)} sold</span>
                  </p>
                </div>
                <span className="flex items-center gap-1 text-sm font-semibold text-brand-600 dark:text-brand-300">
                  <Store className="h-4 w-4" /> Visit
                </span>
              </Link>

              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                {[
                  [Truck, 'Free delivery', 'over ₹999'],
                  [RotateCcw, '7-day returns', 'easy pickup'],
                  [ShieldCheck, 'Secure payment', 'via Stripe'],
                ].map(([Icon, title, sub]) => (
                  <div key={title} className="rounded-2xl bg-zinc-50 p-3 dark:bg-white/[0.03]">
                    <Icon className="mx-auto h-5 w-5 text-brand-600 dark:text-brand-300" />
                    <p className="mt-1.5 font-semibold">{title}</p>
                    <p className="muted">{sub}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-12">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'description', label: 'Description' },
              { value: 'specs', label: 'Specifications' },
            ]}
          />
          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="card mt-4 p-6">
              {tab === 'description' ? (
                <div className="space-y-4">
                  <p className="leading-relaxed text-zinc-700 dark:text-zinc-300">{product.description || 'No description provided.'}</p>
                  {product.tags?.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {product.tags.map((t) => (
                        <Link key={t} to={`/search?q=${encodeURIComponent(t)}`} className="chip">
                          #{t}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <dl className="divide-y divide-zinc-100 dark:divide-white/5">
                  {[
                    { label: 'Brand', value: product.brand },
                    { label: 'Category', value: data.category?.name || '—' },
                    product.sku && { label: 'SKU', value: product.sku },
                    ...(product.specs || []),
                  ]
                    .filter(Boolean)
                    .map((s) => (
                      <div key={s.label} className="grid grid-cols-3 gap-4 py-3 text-sm">
                        <dt className="font-medium muted">{s.label}</dt>
                        <dd className="col-span-2">{s.value}</dd>
                      </div>
                    ))}
                </dl>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="mt-14">
          <Reviews product={product} />
        </div>
      </div>

      <ProductRail className="mt-8" title="You may also like" subtitle={`More from ${data.category?.name || 'this category'}`} products={data.related} viewAll={`/search?category=${product.category}`} />

      {shopper && !outOfStock && (
        <div className="glass fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t px-4 py-3 lg:hidden">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs muted">{product.title}</p>
            <p className="font-display text-lg font-bold">{money(product.price)}</p>
          </div>
          {cartControl(true)}
          <button type="button" onClick={() => addToCart(true)} disabled={adding} className="btn btn-accent">
            {inCart ? 'Go to cart' : 'Buy now'}
          </button>
        </div>
      )}
      <ShareModal open={sharing} onClose={() => setSharing(false)} product={product} />
    </div>
  );
}
