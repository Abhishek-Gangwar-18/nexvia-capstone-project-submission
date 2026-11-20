import { useState } from 'react';
import { motion } from 'framer-motion';
import { Lock, Mail } from 'lucide-react';
import toast from 'react-hot-toast';
import { errorMessage } from '../../lib/api';
import { login } from '../../lib/session';
import { PasswordInput } from '../ui/Controls';
import { Spinner } from '../ui/Feedback';

/** Email + password sign-in. onDone gets the signed-in user; onSwitch shows sign-up instead. */
interface LoginFormProps {
  onDone?: any;
  onSwitch?: any;
}

export default function LoginForm({ onDone, onSwitch }: LoginFormProps) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setLoading(true);
    setError('');
    try {
      const signedIn = await login(form);
      toast.success(`Welcome back, ${signedIn.name.split(' ')[0]}!`);
      onDone?.(signedIn);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2 className="font-display text-3xl font-extrabold tracking-tight">Welcome back</h2>
      <p className="mt-2 muted">Sign in to track orders, manage your store or run the marketplace.</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="mt-8 space-y-4"
      >
        <div>
          <label className="label" htmlFor="email">Email</label>
          <div className="relative">
            <Mail className="absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input id="email" type="email" required autoFocus autoComplete="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className="input pl-10" placeholder="you@example.com" />
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
      {onSwitch && (
        <p className="mt-6 text-center text-sm muted">
          New to Vendora?{' '}
          <button type="button" onClick={onSwitch} className="font-semibold text-brand-600 hover:underline dark:text-brand-300">
            Create an account
          </button>
        </p>
      )}
    </div>
  );
}
