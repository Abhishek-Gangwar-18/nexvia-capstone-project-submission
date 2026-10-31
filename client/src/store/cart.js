import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** UI state for the cart drawer and the coupon chosen in the cart. The cart itself lives on the server. */
export const useCartStore = create(
  persist(
    (set) => ({
      drawerOpen: false,
      couponCode: '',
      /** Bumped when the server reports a coupon change: the coupon box re-checks the applied coupon. */
      couponCheck: 0,

      openDrawer: () => set({ drawerOpen: true }),
      closeDrawer: () => set({ drawerOpen: false }),
      setCouponCode: (couponCode) => set({ couponCode }),
      recheckCoupon: () => set((s) => ({ couponCheck: s.couponCheck + 1 })),
    }),
    { name: 'vendora-cart-ui', partialize: (state) => ({ couponCode: state.couponCode }) },
  ),
);
