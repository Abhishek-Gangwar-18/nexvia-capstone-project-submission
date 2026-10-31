import { lazy, Suspense, useEffect } from 'react';
import { Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import {
  BarChart3, Boxes, Cog, LayoutDashboard, LayoutGrid, MessageSquare, CreditCard, RotateCcw, Package, Settings, ShoppingCart, Store, Ticket, Users, Wallet,
} from 'lucide-react';
import MainLayout from './components/layout/MainLayout';
import DashboardLayout from './components/layout/DashboardLayout';
import RequireAuth from './components/RequireAuth';
import AuthModal, { AuthRedirect } from './components/auth/AuthModal';
import { PageLoader } from './components/ui/Feedback';
import { useAuth } from './store/auth';
import { checkSession, refreshMe } from './lib/session';

const Home = lazy(() => import('./pages/Home'));
const Search = lazy(() => import('./pages/Search'));
const ProductDetail = lazy(() => import('./pages/ProductDetail'));
const Stores = lazy(() => import('./pages/Stores'));
const StorePage = lazy(() => import('./pages/StorePage'));
const Cart = lazy(() => import('./pages/Cart'));
const Checkout = lazy(() => import('./pages/Checkout'));
const Orders = lazy(() => import('./pages/Orders'));
const OrderDetail = lazy(() => import('./pages/OrderDetail'));
const Account = lazy(() => import('./pages/Account'));
const Sell = lazy(() => import('./pages/Sell'));
const NotFound = lazy(() => import('./pages/NotFound'));
const Blocked = lazy(() => import('./pages/Blocked'));

const VendorOnboarding = lazy(() => import('./pages/vendor/Onboarding'));
const VendorDashboard = lazy(() => import('./pages/vendor/Dashboard'));
const VendorProducts = lazy(() => import('./pages/vendor/Products'));
const ProductForm = lazy(() => import('./pages/vendor/ProductForm'));
const VendorOrders = lazy(() => import('./pages/vendor/Orders'));
const VendorPayouts = lazy(() => import('./pages/vendor/Payouts'));
const VendorReviews = lazy(() => import('./pages/vendor/Reviews'));
const VendorReturns = lazy(() => import('./pages/vendor/Returns'));
const VendorSettings = lazy(() => import('./pages/vendor/StoreSettings'));
const CouponManager = lazy(() => import('./pages/shared/CouponManager'));

const AdminAnalytics = lazy(() => import('./pages/admin/Analytics'));
const AdminVendors = lazy(() => import('./pages/admin/Vendors'));
const AdminUsers = lazy(() => import('./pages/admin/Users'));
const AdminOrders = lazy(() => import('./pages/admin/Orders'));
const AdminProducts = lazy(() => import('./pages/admin/Products'));
const AdminSettings = lazy(() => import('./pages/admin/Settings'));
const AdminCategories = lazy(() => import('./pages/admin/Categories'));
const AdminReviews = lazy(() => import('./pages/admin/Reviews'));
const AdminReturns = lazy(() => import('./pages/admin/Returns'));
const AdminPayments = lazy(() => import('./pages/admin/Payments'));

const VENDOR_NAV = [
  { to: '/vendor', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/vendor/products', label: 'Products', icon: Boxes },
  { to: '/vendor/orders', label: 'Orders', icon: Package },
  { to: '/vendor/coupons', label: 'Coupons', icon: Ticket },
  { to: '/vendor/returns', label: 'Returns', icon: RotateCcw },
  { to: '/vendor/reviews', label: 'Reviews', icon: MessageSquare },
  { to: '/vendor/payouts', label: 'Payouts', icon: Wallet },
  { to: '/vendor/settings', label: 'Store settings', icon: Settings },
];

const ADMIN_NAV = [
  { to: '/admin', label: 'Analytics', icon: BarChart3, end: true },
  { to: '/admin/vendors', label: 'Vendors', icon: Store },
  { to: '/admin/orders', label: 'Orders', icon: ShoppingCart },
  { to: '/admin/products', label: 'Products', icon: Boxes },
  { to: '/admin/categories', label: 'Categories', icon: LayoutGrid },
  { to: '/admin/payments', label: 'Payments', icon: CreditCard },
  { to: '/admin/returns', label: 'Returns', icon: RotateCcw },
  { to: '/admin/reviews', label: 'Reviews', icon: MessageSquare },
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/coupons', label: 'Coupons', icon: Ticket },
  { to: '/admin/settings', label: 'Settings & system', icon: Cog },
];

/** /register?role=vendor (the Sell page's old link) opens sign-up on the seller tab. */
function RegisterRedirect() {
  const [params] = useSearchParams();
  return <AuthRedirect view="register" role={params.get('role') === 'vendor' ? 'vendor' : 'customer'} />;
}

export default function App() {
  const signedIn = useAuth((s) => Boolean(s.user));
  const blocked = useAuth((s) => Boolean(s.blocked));
  const { pathname } = useLocation();

  // On load: get a fresh access token from the refresh cookie (the API client does it before the first
  // request) and refresh the cached profile so role / store approval changes are picked up.
  useEffect(() => {
    if (signedIn) refreshMe().catch(() => {});
  }, [signedIn]);

  // Every page change re-checks the session (pages may render from cache without asking the API),
  // as do coming back to the tab and a slow timer, so a block takes effect on the next click.
  useEffect(() => {
    if (signedIn) checkSession();
  }, [signedIn, pathname]);
  useEffect(() => {
    if (!signedIn) return undefined;
    const timer = setInterval(checkSession, 60 * 1000);
    window.addEventListener('focus', checkSession);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', checkSession);
    };
  }, [signedIn]);

  // A blocked account sees nothing of the site, on any URL.
  if (blocked) {
    return (
      <Suspense fallback={<PageLoader />}>
        <Blocked />
      </Suspense>
    );
  }

  return (
    <>
      <Suspense fallback={<PageLoader />}>
        <Routes>
        <Route element={<MainLayout />}>
          <Route index element={<Home />} />
          <Route path="search" element={<Search />} />
          <Route path="product/:productId" element={<ProductDetail />} />
          <Route path="stores" element={<Stores />} />
          <Route path="store/:storeId" element={<StorePage />} />
          <Route path="cart" element={<Cart />} />
          <Route path="sell" element={<Sell />} />
          <Route path="login" element={<AuthRedirect view="login" />} />
          <Route path="register" element={<RegisterRedirect />} />

          <Route element={<RequireAuth roles={['customer']} />}>
            <Route path="checkout" element={<Checkout />} />
            <Route path="orders" element={<Orders />} />
            <Route path="orders/:id" element={<OrderDetail />} />
          </Route>
          <Route element={<RequireAuth />}>
            <Route path="account" element={<Account />} />
          </Route>
          <Route element={<RequireAuth roles={['vendor', 'customer']} />}>
            <Route path="vendor/onboarding" element={<VendorOnboarding />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>

        <Route element={<RequireAuth roles={['vendor']} approvedVendor />}>
          <Route path="vendor" element={<DashboardLayout nav={VENDOR_NAV} title="Seller Hub" variant="vendor" />}>
            <Route index element={<VendorDashboard />} />
            <Route path="products" element={<VendorProducts />} />
            <Route path="products/new" element={<ProductForm />} />
            <Route path="products/:id/edit" element={<ProductForm />} />
            <Route path="orders" element={<VendorOrders />} />
            <Route path="coupons" element={<CouponManager scope="vendor" />} />
            <Route path="returns" element={<VendorReturns />} />
            <Route path="reviews" element={<VendorReviews />} />
            <Route path="payouts" element={<VendorPayouts />} />
            <Route path="settings" element={<VendorSettings />} />
          </Route>
        </Route>

        <Route element={<RequireAuth roles={['admin']} />}>
          <Route path="admin" element={<DashboardLayout nav={ADMIN_NAV} title="Admin Console" variant="admin" />}>
            <Route index element={<AdminAnalytics />} />
            <Route path="vendors" element={<AdminVendors />} />
            <Route path="orders" element={<AdminOrders />} />
            <Route path="orders/:id" element={<OrderDetail admin />} />
            <Route path="products" element={<AdminProducts />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="coupons" element={<CouponManager scope="admin" />} />
            <Route path="categories" element={<AdminCategories />} />
            <Route path="payments" element={<AdminPayments />} />
            <Route path="returns" element={<AdminReturns />} />
            <Route path="reviews" element={<AdminReviews />} />
            <Route path="settings" element={<AdminSettings />} />
          </Route>
        </Route>
        </Routes>
      </Suspense>
      {/* Outside Suspense so a lazy page loading behind it never unmounts the open modal. */}
      <AuthModal />
    </>
  );
}
