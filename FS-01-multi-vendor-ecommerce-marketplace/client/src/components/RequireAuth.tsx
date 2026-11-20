import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { homeFor } from '../lib/session';
import { AuthRedirect } from './auth/AuthModal';

/** Guards a route subtree by login and (optionally) role. Vendors without an approved store go to onboarding. */
interface RequireAuthProps {
  roles?: any;
  approvedVendor?: any;
}

export default function RequireAuth({ roles, approvedVendor = false }: RequireAuthProps) {
  const user = useAuth((s) => s.user);
  const location = useLocation();

  if (!user) return <AuthRedirect from={location.pathname + location.search} />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user)} replace />;
  if (approvedVendor && user.vendor?.status !== 'approved') return <Navigate to="/vendor/onboarding" replace />;
  return <Outlet />;
}
