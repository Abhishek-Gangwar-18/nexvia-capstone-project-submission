import { useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../../store/auth';
import { useAuthModal } from '../../store/authModal';
import { homeFor } from '../../lib/session';
import { Modal } from '../ui/Modal';
import BrandPanel from './BrandPanel';
import LoginForm from './LoginForm';
import RegisterForm from './RegisterForm';

/**
 * Sign-in / sign-up, shown over the current page (opened through store/authModal). Shoppers stay where
 * they were, or go on to `from` (e.g. checkout); sellers and admins go to their dashboards.
 */
export default function AuthModal() {
  const { view, from, role, switchTo, close } = useAuthModal();
  const navigate = useNavigate();

  const done = (user, isNew = false) => {
    close();
    if (isNew && user.role === 'vendor') navigate('/vendor/onboarding', { replace: true });
    else if (user.role !== 'customer') navigate(homeFor(user), { replace: true });
    else if (from) navigate(from, { replace: true });
  };

  return (
    <Modal open={Boolean(view)} onClose={close} size="xl" bare>
      <div className="grid lg:grid-cols-[1fr_1.15fr]">
        <BrandPanel className="hidden lg:flex" />
        <div className="p-6 pt-12 sm:p-10">
          {view === 'register' ? (
            <RegisterForm key="register" initialRole={role} onDone={(u) => done(u, true)} onSwitch={() => switchTo('login')} />
          ) : (
            <LoginForm key="login" onDone={(u) => done(u)} onSwitch={() => switchTo('register')} />
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Route-level entry (old /login and /register links, guarded pages): opens the modal over the home page. */
export function AuthRedirect({ view = 'login', from = null, role = 'customer' }) {
  const user = useAuth((s) => s.user);
  const open = useAuthModal((s) => s.open);
  useEffect(() => {
    if (!user) open(view, { from, role });
    // Opens once, on arrival.
  }, []);
  return <Navigate to={user ? homeFor(user) : '/'} replace />;
}
