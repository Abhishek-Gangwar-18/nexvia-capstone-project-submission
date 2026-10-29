import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Lock, Mail, ShoppingBag, Store } from 'lucide-react';
import toast from 'react-hot-toast';
import { errorMessage } from '../../lib/api';
import { homeFor, login } from '../../lib/session';
import { useAuth } from '../../store/auth';
import { cn } from '../../lib/format';
import { PasswordInput } from '../../components/ui/Controls';
import { Spinner } from '../../components/ui/Feedback';
import AuthShell from './AuthShell';

// Seeded demo accounts. There is deliberately no admin here - the platform owner signs in with their own account.
const DEMO = [
  { role: 'Customer', email: 'customer@vendora.dev', password: 'Customer@123', icon: ShoppingBag, color: 'from-sky-500 to-indigo-500' },
  { role: 'Seller', email: 'technova@vendora.dev', password: 'Vendor@123', icon: Store, color: 'from-amber-400 to-orange-500' },
];

export default function Login() {
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Only bounce users who arrive already signed in; a fresh login navigates itself below.
  const [signedInOnArrival] = useState(Boolean(user));

  if (signedInOnArrival && user) return <Navigate to={homeFor(user)} replace />;

  const submit = async (credentials = form) => {
    setLoading(true);
    setError('');
    try {
      const signedIn = await login(credentials);
      toast.success(`Welcome back, ${signedIn.name.split(' ')[0]}!`);
      const from = location.state?.from?.pathname;
      navigate(from && signedIn.role === 'customer' ? from : homeFor(signedIn), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to track orders, manage your store or run the marketplace.">
      <div className="mb-6">
        <p className="mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">One-click demo accounts</p>
        <div className="grid grid-cols-2 gap-2">
          {DEMO.map((d) => (
            <motion.button
              key={d.role}
              type="button"
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.96 }}
              disabled={loading}
              onClick={() => {
                setForm({ email: d.email, password: d.password });
                submit({ email: d.email, password: d.password });
              }}
              className="card flex flex-col items-center gap-2 p-3 text-xs font-semibold transition hover:border-brand-300 hover:shadow-md"
            >
              <span className={cn('flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br text-white', d.color)}>
                <d.icon className="h-4 w-4" />
              </span>
              {d.role}
            </motion.button>
          ))}
        </div>
      </div>

      <div className="relative mb-6 text-center text-xs muted">
        <span className="relative z-10 bg-canvas px-3 dark:bg-canvas-dark">or sign in with email</span>
        <div className="absolute top-1/2 right-0 left-0 h-px bg-zinc-200 dark:bg-white/10" />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-4"
      >
        <div>
          <label className="label" htmlFor="email">Email</label>
          <div className="relative">
            <Mail className="absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input id="email" type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className="input pl-10" placeholder="you@example.com" />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <PasswordInput id="password" icon={Lock} required autoComplete="current-password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder="••••••••" />
        </div>
        {error && (
          <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {error}
          </motion.p>
        )}
        <button type="submit" disabled={loading} className="btn btn-primary btn-lg w-full">
          {loading && <Spinner className="h-4 w-4" />} Sign in
        </button>
      </form>
      <p className="mt-6 text-center text-sm muted">
        New to Vendora?{' '}
        <Link to="/register" className="font-semibold text-brand-600 hover:underline dark:text-brand-300">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
