import { useState } from 'react';
import { motion } from 'framer-motion';
import { Lock, Mail, ShoppingBag, Store, User } from 'lucide-react';
import toast from 'react-hot-toast';
import { errorMessage } from '../../lib/api';
import { register } from '../../lib/session';
import { cn } from '../../lib/format';
import { PasswordInput } from '../ui/Controls';
import { Spinner } from '../ui/Feedback';

function strength(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 10) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}
const ROLES = [
  { value: 'customer', label: 'I want to shop', icon: ShoppingBag, color: 'from-sky-500 to-indigo-500' },
  { value: 'vendor', label: 'I want to sell', icon: Store, color: 'from-amber-400 to-orange-500' },
];
const STRENGTH = [
  ['Too short', 'bg-rose-500'],
  ['Weak', 'bg-rose-500'],
  ['Okay', 'bg-amber-400'],
  ['Good', 'bg-emerald-400'],
  ['Strong', 'bg-emerald-500'],
];

/** Sign-up form for shoppers and sellers. onDone gets the new user; onSwitch shows sign-in instead. */
export default function RegisterForm({ initialRole = 'customer', onDone, onSwitch }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: initialRole === 'vendor' ? 'vendor' : 'customer' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const score = strength(form.password);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const created = await register(form);
      toast.success(`Welcome to Vendora, ${created.name.split(' ')[0]}!`);
      onDone?.(created);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <div>
      <h2 className="font-display text-3xl font-extrabold tracking-tight">Create your account</h2>
      <p className="mt-2 muted">{form.role === 'vendor' ? 'Open your store and start selling in minutes.' : 'Shop from hundreds of independent sellers.'}</p>
      <div role="radiogroup" aria-label="Account type" className="mt-6 mb-6 grid grid-cols-2 gap-2">
        {ROLES.map((r) => {
          const selected = form.role === r.value;
          return (
            <motion.button
              key={r.value}
              type="button"
              role="radio"
              aria-checked={selected}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.96 }}
              onClick={() => setForm((f) => ({ ...f, role: r.value }))}
              className={cn(
                'card flex flex-col items-center gap-2 p-3 text-xs font-semibold transition hover:border-brand-300 hover:shadow-md',
                selected && 'border-brand-500 ring-2 ring-brand-500/30 dark:border-brand-400',
              )}
            >
              <span className={cn('flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br text-white', r.color)}>
                <r.icon className="h-4 w-4" />
              </span>
              {r.label}
            </motion.button>
          );
        })}
      </div>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="name">{form.role === 'vendor' ? 'Your name' : 'Full name'}</label>
          <div className="relative">
            <User className="absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input id="name" required autoFocus minLength={2} value={form.name} onChange={set('name')} className="input pl-10" placeholder="Aarav Patel" autoComplete="name" />
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
      {onSwitch && (
        <p className="mt-6 text-center text-sm muted">
          Already have an account?{' '}
          <button type="button" onClick={onSwitch} className="font-semibold text-brand-600 hover:underline dark:text-brand-300">
            Sign in
          </button>
        </p>
      )}
    </div>
  );
}
