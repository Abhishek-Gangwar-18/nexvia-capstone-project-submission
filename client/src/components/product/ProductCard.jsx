import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Heart, Plus, ShoppingBag } from 'lucide-react';
import { useCartActions } from '../../lib/cart';
import { useWishlist } from '../../lib/hooks';
import { cn, discountOf } from '../../lib/format';
import Price from '../ui/Price';
import { RatingPill } from '../ui/Rating';
import { Skeleton } from '../ui/Feedback';

export function WishlistButton({ productId, className }) {
  const wishlist = useWishlist();
  const navigate = useNavigate();
  const active = wishlist.has(productId);
  if (wishlist.isLoggedIn && !wishlist.canUse) return null;
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.8 }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!wishlist.isLoggedIn) return navigate('/login');
        return wishlist.toggle(productId);
      }}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-full bg-white/90 shadow-md ring-1 ring-black/5 backdrop-blur transition hover:scale-110 dark:bg-zinc-900/80 dark:ring-white/10',
        className,
      )}
      aria-label={active ? 'Remove from wishlist' : 'Add to wishlist'}
    >
      <motion.span key={String(active)} initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 12 }}>
        <Heart className={cn('h-4 w-4', active ? 'fill-rose-500 text-rose-500' : 'text-zinc-500 dark:text-zinc-300')} />
      </motion.span>
    </motion.button>
  );
}

/** Cursor-following 3D tilt for product cards (desktop only). */
function useTilt() {
  const ref = useRef(null);
  const [style, setStyle] = useState({});
  const onMouseMove = (e) => {
    const rect = ref.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    setStyle({ transform: `perspective(900px) rotateX(${(-y * 5).toFixed(2)}deg) rotateY(${(x * 5).toFixed(2)}deg) translateY(-4px)` });
  };
  const onMouseLeave = () => setStyle({ transform: 'perspective(900px) rotateX(0) rotateY(0) translateY(0)' });
  return { ref, style, onMouseMove, onMouseLeave };
}

export default function ProductCard({ product, index = 0 }) {
  const { add } = useCartActions();
  const [added, setAdded] = useState(false);
  const tilt = useTilt();
  const discount = product.discount ?? discountOf(product);
  const outOfStock = product.stock <= 0;

  const quickAdd = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (outOfStock) return;
    const ok = await add(product, 1, { openDrawer: false });
    if (ok) {
      setAdded(true);
      setTimeout(() => setAdded(false), 1600);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.35, delay: Math.min(index, 8) * 0.04 }}
    >
      <Link
        to={`/product/${product._id}`}
        ref={tilt.ref}
        onMouseMove={tilt.onMouseMove}
        onMouseLeave={tilt.onMouseLeave}
        style={tilt.style}
        className="group card relative flex h-full flex-col overflow-hidden transition-[transform,box-shadow] duration-200 ease-out hover:shadow-xl hover:shadow-brand-900/[0.07]"
      >
        <div className="relative aspect-square overflow-hidden bg-gradient-to-br from-zinc-50 to-zinc-100/80 dark:from-white/[0.04] dark:to-white/[0.02]">
          <img
            src={product.thumbnail}
            alt={product.title}
            loading="lazy"
            className={cn('h-full w-full object-contain p-5 transition duration-500 group-hover:scale-[1.07]', outOfStock && 'opacity-50 grayscale')}
          />
          <div className="absolute top-3 left-3 flex flex-col gap-1.5">
            {discount >= 5 && (
              <span className="rounded-lg bg-gradient-to-r from-rose-500 to-orange-500 px-2 py-1 text-[11px] font-bold text-white shadow-md shadow-rose-500/30">
                −{discount}%
              </span>
            )}
            {product.sold > 500 && <span className="rounded-lg bg-zinc-900/85 px-2 py-1 text-[10px] font-bold tracking-wide text-white uppercase backdrop-blur">Bestseller</span>}
          </div>
          <WishlistButton productId={product._id} className="absolute top-3 right-3 opacity-100 md:opacity-0 md:group-hover:opacity-100" />

          {!outOfStock && (
            <motion.button
              type="button"
              onClick={quickAdd}
              whileTap={{ scale: 0.92 }}
              className={cn(
                'absolute right-3 bottom-3 flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold shadow-lg transition-all duration-300',
                'translate-y-0 opacity-100 md:translate-y-3 md:opacity-0 md:group-hover:translate-y-0 md:group-hover:opacity-100',
                added ? 'bg-emerald-500 text-white' : 'bg-zinc-900 text-white hover:bg-brand-600 dark:bg-white dark:text-zinc-900 dark:hover:bg-brand-300',
              )}
              aria-label="Add to cart"
            >
              <AnimatePresence mode="wait" initial={false}>
                {added ? (
                  <motion.span key="ok" initial={{ scale: 0 }} animate={{ scale: 1 }} className="flex items-center gap-1">
                    <Check className="h-3.5 w-3.5" /> Added
                  </motion.span>
                ) : (
                  <motion.span key="add" initial={{ scale: 0 }} animate={{ scale: 1 }} className="flex items-center gap-1">
                    <Plus className="h-3.5 w-3.5 md:hidden" />
                    <ShoppingBag className="hidden h-3.5 w-3.5 md:block" /> <span className="hidden md:inline">Add</span>
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.button>
          )}
          {outOfStock && <span className="absolute inset-x-3 bottom-3 rounded-lg bg-zinc-900/80 py-1.5 text-center text-xs font-bold text-white">Out of stock</span>}
        </div>

        <div className="flex flex-1 flex-col gap-1.5 p-4">
          {product.storeName && <p className="truncate text-[11px] font-semibold tracking-wide text-brand-600 uppercase dark:text-brand-300">{product.storeName}</p>}
          <h3 className="line-clamp-2 min-h-[2.5rem] text-sm leading-5 font-semibold text-zinc-800 group-hover:text-brand-700 dark:text-zinc-100 dark:group-hover:text-brand-200">
            {product.title}
          </h3>
          <RatingPill value={product.rating || 0} count={product.numRatings || 0} />
          <div className="mt-auto pt-1">
            <Price price={product.price} mrp={product.mrp} size="sm" />
            {!outOfStock && product.stock <= 5 && <p className="mt-1 text-[11px] font-semibold text-orange-600 dark:text-orange-400">Only {product.stock} left</p>}
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

export function ProductCardSkeleton() {
  return (
    <div className="card overflow-hidden">
      <Skeleton className="aspect-square rounded-none" />
      <div className="space-y-2 p-4">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
      </div>
    </div>
  );
}

export function ProductGrid({ products, loading, count = 8, className }) {
  return (
    <div className={cn('grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4', className)}>
      {loading
        ? Array.from({ length: count }, (_, i) => <ProductCardSkeleton key={i} />)
        : products.map((p, i) => <ProductCard key={p._id} product={p} index={i} />)}
    </div>
  );
}
