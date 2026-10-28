import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** UI state for the cart drawer and the coupon chosen in the cart. The cart itself lives on the server. */
export const useCartStore = create(
  persist(
    (set) => ({
      drawerOpen: false,
      couponCode: '',

      openDrawer: () => set({ drawerOpen: true }),
      closeDrawer: () => set({ drawerOpen: false }),
      setCouponCode: (couponCode) => set({ couponCode }),
    }),
    { name: 'vendora-cart-ui', partialize: (state) => ({ couponCode: state.couponCode }) },
  ),
);
