import { lazy, Suspense, useEffect } from 'react';
import { Route, Routes } from 'react-router-dom';
import {
  BarChart3, Boxes, Cog, LayoutDashboard, Package, Settings, ShoppingCart, Store, Ticket, Users, Wallet,
} from 'lucide-react';
import MainLayout from './components/layout/MainLayout';
import DashboardLayout from './components/layout/DashboardLayout';
import RequireAuth from './components/RequireAuth';
import { PageLoader } from './components/ui/Feedback';
import { useAuth } from './store/auth';
import { refreshMe } from './lib/session';

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
const Login = lazy(() => import('./pages/auth/Login'));
const Register = lazy(() => import('./pages/auth/Register'));
const VerifyEmail = lazy(() => import('./pages/auth/VerifyEmail'));
const Sell = lazy(() => import('./pages/Sell'));
const NotFound = lazy(() => import('./pages/NotFound'));

const VendorOnboarding = lazy(() => import('./pages/vendor/Onboarding'));
const VendorDashboard = lazy(() => import('./pages/vendor/Dashboard'));
const VendorProducts = lazy(() => import('./pages/vendor/Products'));
const ProductForm = lazy(() => import('./pages/vendor/ProductForm'));
const VendorOrders = lazy(() => import('./pages/vendor/Orders'));
const VendorPayouts = lazy(() => import('./pages/vendor/Payouts'));
const VendorSettings = lazy(() => import('./pages/vendor/StoreSettings'));
const CouponManager = lazy(() => import('./pages/shared/CouponManager'));

const AdminAnalytics = lazy(() => import('./pages/admin/Analytics'));
const AdminVendors = lazy(() => import('./pages/admin/Vendors'));
const AdminUsers = lazy(() => import('./pages/admin/Users'));
const AdminOrders = lazy(() => import('./pages/admin/Orders'));
const AdminProducts = lazy(() => import('./pages/admin/Products'));
const AdminSettings = lazy(() => import('./pages/admin/Settings'));

const VENDOR_NAV = [
  { to: '/vendor', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/vendor/products', label: 'Products', icon: Boxes },
  { to: '/vendor/orders', label: 'Orders', icon: Package },
  { to: '/vendor/coupons', label: 'Coupons', icon: Ticket },
  { to: '/vendor/payouts', label: 'Payouts', icon: Wallet },
  { to: '/vendor/settings', label: 'Store settings', icon: Settings },
];

const ADMIN_NAV = [
  { to: '/admin', label: 'Analytics', icon: BarChart3, end: true },
  { to: '/admin/vendors', label: 'Vendors', icon: Store },
  { to: '/admin/orders', label: 'Orders', icon: ShoppingCart },
  { to: '/admin/products', label: 'Products', icon: Boxes },
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/coupons', label: 'Coupons', icon: Ticket },
  { to: '/admin/settings', label: 'Settings & system', icon: Cog },
];

export default function App() {
  const token = useAuth((s) => s.token);

  // Refresh the cached profile on load so role / store approval changes are picked up.
  useEffect(() => {
    if (token) refreshMe().catch(() => {});
  }, [token]);

  return (
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
          <Route path="login" element={<Login />} />
          <Route path="register" element={<Register />} />
          <Route path="verify-email" element={<VerifyEmail />} />

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
            <Route path="settings" element={<AdminSettings />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
