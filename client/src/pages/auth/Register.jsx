import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Lock, Mail, ShoppingBag, Store, User } from 'lucide-react';
import toast from 'react-hot-toast';
import { errorMessage } from '../../lib/api';
import { homeFor, register } from '../../lib/session';
import { useAuth } from '../../store/auth';
import { cn } from '../../lib/format';
import { PasswordInput, Segmented } from '../../components/ui/Controls';
import { Spinner } from '../../components/ui/Feedback';
import AuthShell from './AuthShell';

function strength(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 10) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}
const STRENGTH = [
  ['Too short', 'bg-rose-500'],
  ['Weak', 'bg-rose-500'],
  ['Okay', 'bg-amber-400'],
  ['Good', 'bg-emerald-400'],
  ['Strong', 'bg-emerald-500'],
];

export default function Register() {
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: params.get('role') === 'vendor' ? 'vendor' : 'customer' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [signedInOnArrival] = useState(Boolean(user));

  if (signedInOnArrival && user) return <Navigate to={homeFor(user)} replace />;
  const score = strength(form.password);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const created = await register(form);
      toast.success(`Welcome to Vendora, ${created.name.split(' ')[0]}!`);
      navigate(created.role === 'vendor' ? '/vendor/onboarding' : '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <AuthShell title="Create your account" subtitle={form.role === 'vendor' ? 'Open your store and start selling in minutes.' : 'Shop from hundreds of independent sellers.'}>
      <Segmented
        className="mb-6 w-full [&>button]:flex-1"
        value={form.role}
        onChange={(role) => setForm((f) => ({ ...f, role }))}
        options={[
          { value: 'customer', label: 'I want to shop', icon: ShoppingBag },
          { value: 'vendor', label: 'I want to sell', icon: Store },
        ]}
      />
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="name">{form.role === 'vendor' ? 'Your name' : 'Full name'}</label>
          <div className="relative">
            <User className="absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input id="name" required minLength={2} value={form.name} onChange={set('name')} className="input pl-10" placeholder="Aarav Patel" autoComplete="name" />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="reg-email">Email</label>
          <div className="relative">
            <Mail className="absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input id="reg-email" type="email" required value={form.email} onChange={set('email')} className="input pl-10" placeholder="you@example.com" autoComplete="email" />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="reg-password">Password</label>
          <PasswordInput id="reg-password" icon={Lock} required minLength={8} value={form.password} onChange={set('password')} placeholder="At least 8 characters" autoComplete="new-password" />
          {form.password && (
            <div className="mt-2 flex items-center gap-2">
              <div className="flex flex-1 gap-1">
                {[0, 1, 2, 3].map((i) => (
                  <motion.span key={i} className={cn('h-1.5 flex-1 rounded-full', i < score ? STRENGTH[score][1] : 'bg-zinc-200 dark:bg-white/10')} initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} />
                ))}
              </div>
              <span className="w-16 text-right text-xs font-semibold muted">{STRENGTH[score][0]}</span>
            </div>
          )}
        </div>
        {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>}
        <button type="submit" disabled={loading} className="btn btn-primary btn-lg w-full">
          {loading && <Spinner className="h-4 w-4" />} {form.role === 'vendor' ? 'Create seller account' : 'Create account'}
        </button>
        {form.role === 'vendor' && <p className="text-center text-xs muted">Next you’ll add your store, business and payout details for admin approval.</p>}
      </form>
      <p className="mt-6 text-center text-sm muted">
        Already have an account?{' '}
        <Link to="/login" className="font-semibold text-brand-600 hover:underline dark:text-brand-300">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
