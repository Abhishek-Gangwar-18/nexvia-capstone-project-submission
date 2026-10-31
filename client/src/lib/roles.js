/**
 * Who may buy, and where each role's "seller" links should go. Only guests and customers shop; vendors
 * and admins are sent to their own consoles instead of being invited to buy or to become a seller.
 */
export const canShop = (user) => !user || user.role === 'customer';

/** A vendor's own area: the Seller Hub once approved, otherwise their application status page. */
export function sellerHome(user) {
  if (user?.role === 'admin') return { to: '/admin', label: 'Open Admin console' };
  if (user?.role === 'vendor') {
    return user.vendor?.status === 'approved' ? { to: '/vendor', label: 'Go to Seller Hub' } : { to: '/vendor/onboarding', label: 'View application status' };
  }
  return null; // guests and customers: show the "Become a seller" invitation
}
