import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const MAX_PER_ITEM = 10;

/**
 * Guest cart (kept in the browser until login, then merged into the Redis-backed server cart),
 * plus UI state for the cart drawer and the coupon chosen in the cart.
 */
export const useCartStore = create(
  persist(
    (set) => ({
      guestItems: [],
      drawerOpen: false,
      couponCode: '',

      openDrawer: () => set({ drawerOpen: true }),
      closeDrawer: () => set({ drawerOpen: false }),
      setCouponCode: (couponCode) => set({ couponCode }),

      addGuest: (product, quantity = 1) =>
        set((state) => {
          const limit = Math.min(product.stock ?? MAX_PER_ITEM, MAX_PER_ITEM);
          const existing = state.guestItems.find((i) => i.productId === product._id);
          if (existing) {
            return {
              guestItems: state.guestItems.map((i) =>
                i.productId === product._id ? { ...i, quantity: Math.min(i.quantity + quantity, limit) } : i,
              ),
            };
          }
          const line = {
            productId: product._id,
            quantity: Math.min(quantity, limit),
            maxQuantity: limit,
            inStock: (product.stock ?? 1) > 0,
            product: {
              _id: product._id,
              title: product.title,
              slug: product.slug,
              thumbnail: product.thumbnail,
              price: product.price,
              mrp: product.mrp,
              stock: product.stock,
              brand: product.brand,
            },
            vendor: { _id: product.vendorId || product.vendor?._id, storeName: product.storeName || product.vendor?.storeName, slug: product.storeSlug || product.vendor?.slug },
          };
          return { guestItems: [line, ...state.guestItems] };
        }),

      updateGuest: (productId, quantity) =>
        set((state) => ({
          guestItems:
            quantity <= 0
              ? state.guestItems.filter((i) => i.productId !== productId)
              : state.guestItems.map((i) => (i.productId === productId ? { ...i, quantity: Math.min(quantity, i.maxQuantity) } : i)),
        })),

      clearGuest: () => set({ guestItems: [] }),
    }),
    { name: 'vendora-guest-cart', partialize: (state) => ({ guestItems: state.guestItems, couponCode: state.couponCode }) },
  ),
);
