import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Heart, KeyRound, LogOut, MapPin, Monitor, Pencil, Plus, Smartphone, Trash2, User } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { formatDate, timeAgo } from '../lib/format';
import { logoutEverywhere } from '../lib/session';
import { useAuth } from '../store/auth';
import AddressForm from '../components/account/AddressForm';
import ImageUploader from '../components/ui/ImageUploader';
import { Field, PasswordInput } from '../components/ui/Controls';
import { ConfirmDialog } from '../components/ui/Modal';
import { EmptyState, Spinner } from '../components/ui/Feedback';
import { UserAvatar } from '../components/ui/Brand';
import { ProductGrid } from '../components/product/ProductCard';
import { cn } from '../lib/format';

function Profile() {
  const user = useAuth((s) => s.user);
  const setUser = useAuth((s) => s.setUser);
  const [form, setForm] = useState({ name: user.name, phone: user.phone || '', avatar: user.avatar || '' });
  const mutation = useMutation({
    mutationFn: (payload) => api.patch('/auth/me', payload).then((r) => r.data.user),
    onSuccess: (updated) => {
      setUser(updated);
      toast.success('Profile updated');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(form);
      }}
      className="space-y-5"
    >
      <div className="flex items-center gap-4">
        <UserAvatar user={{ ...user, avatar: form.avatar }} size="h-20 w-20" className="text-xl" />
        <div>
          <p className="font-display text-xl font-bold">{user.name}</p>
          <p className="text-sm muted">{user.email} · member since {formatDate(user.createdAt, { day: undefined })}</p>
        </div>
      </div>
      <Field label="Profile photo">
        <ImageUploader single folder="avatars" value={form.avatar ? [{ url: form.avatar }] : []} onChange={(files) => setForm((f) => ({ ...f, avatar: files[0]?.url || '' }))} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name">
          <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="input" />
        </Field>
        <Field label="Phone">
          <input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} className="input" placeholder="98765 43210" />
        </Field>
      </div>
      <Field label="Email" hint="Email can’t be changed">
        <input value={user.email} disabled className="input" />
      </Field>
      <div className="flex justify-end">
        <button type="submit" disabled={mutation.isPending} className="btn btn-primary">
          {mutation.isPending && <Spinner className="h-4 w-4" />} Save changes
        </button>
      </div>
    </form>
  );
}

function Addresses() {
  const user = useAuth((s) => s.user);
  const setUser = useAuth((s) => s.setUser);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const sync = (addresses) => setUser({ ...useAuth.getState().user, addresses });

  const save = useMutation({
    mutationFn: ({ id, payload }) => (id ? api.patch(`/auth/me/addresses/${id}`, payload) : api.post('/auth/me/addresses', payload)).then((r) => r.data),
    onSuccess: (data) => {
      sync(data.addresses);
      setEditing(null);
      toast.success('Address saved');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (id) => api.delete(`/auth/me/addresses/${id}`).then((r) => r.data),
    onSuccess: (data) => {
      sync(data.addresses);
      setDeleting(null);
      toast.success('Address removed');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-sm muted">{user.addresses.length} saved address{user.addresses.length === 1 ? '' : 'es'}</p>
        {!editing && (
          <button type="button" onClick={() => setEditing('new')} className="btn btn-primary btn-sm">
            <Plus className="h-4 w-4" /> Add address
          </button>
        )}
      </div>
      <AnimatePresence>
        {editing && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="mt-4 rounded-2xl border border-dashed border-brand-300 p-5 dark:border-brand-400/30">
              <AddressForm
                initial={editing === 'new' ? { fullName: user.name, phone: user.phone || '' } : editing}
                onSubmit={(payload) => save.mutate({ id: editing === 'new' ? null : editing._id, payload })}
                onCancel={() => setEditing(null)}
                saving={save.isPending}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {user.addresses.map((a) => (
          <motion.div layout key={a._id} className="rounded-2xl border border-zinc-200 p-4 dark:border-white/10">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] font-bold tracking-wide uppercase dark:bg-white/10">{a.label}</span>
              {a.isDefault && <span className="text-[11px] font-semibold text-brand-600">Default</span>}
              <div className="ml-auto flex gap-1">
                <button type="button" onClick={() => setEditing(a)} className="btn-icon h-8 w-8" aria-label="Edit address"><Pencil className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => setDeleting(a)} className="btn-icon h-8 w-8 hover:text-rose-600" aria-label="Delete address"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
            <p className="mt-2 font-semibold">{a.fullName}</p>
            <p className="text-sm muted">{a.line1}{a.line2 ? `, ${a.line2}` : ''}</p>
            <p className="text-sm muted">{a.city}, {a.state} {a.pincode}</p>
            <p className="mt-1 text-xs muted">📞 {a.phone}</p>
          </motion.div>
        ))}
      </div>
      <ConfirmDialog open={Boolean(deleting)} onClose={() => setDeleting(null)} onConfirm={() => remove.mutate(deleting._id)} loading={remove.isPending} danger title="Delete this address?" description={deleting ? `${deleting.line1}, ${deleting.city}` : ''} confirmLabel="Delete" />
    </div>
  );
}

function Wishlist() {
  const { data, isLoading } = useQuery({ queryKey: ['wishlist'], queryFn: () => api.get('/auth/me/wishlist').then((r) => r.data.items) });
  if (!isLoading && !data?.length) {
    return <EmptyState icon={Heart} title="Your wishlist is empty" description="Tap the heart on any product to save it for later." action={<Link to="/search" className="btn btn-primary">Discover products</Link>} />;
  }
  return <ProductGrid products={data || []} loading={isLoading} count={4} className="lg:grid-cols-3" />;
}

function Security() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const setSession = useAuth((s) => s.setSession);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.patch('/auth/me/password', { currentPassword: form.currentPassword, newPassword: form.newPassword }),
    onSuccess: ({ data }) => {
      // Other devices are logged out; this one got a new session (cookie) and access token.
      setSession(data.accessToken, useAuth.getState().user);
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      toast.success('Password updated');
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
      queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const mismatch = form.confirm && form.confirm !== form.newPassword;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (mismatch) return;
        mutation.mutate();
      }}
      className="max-w-md space-y-4"
    >
      <Field label="Current password">
        <PasswordInput value={form.currentPassword} onChange={(e) => setForm((f) => ({ ...f, currentPassword: e.target.value }))} autoComplete="current-password" />
      </Field>
      <Field label="New password" hint="At least 8 characters">
        <PasswordInput value={form.newPassword} onChange={(e) => setForm((f) => ({ ...f, newPassword: e.target.value }))} autoComplete="new-password" />
      </Field>
      <Field label="Confirm new password" error={mismatch ? 'Passwords don’t match' : undefined}>
        <PasswordInput value={form.confirm} onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))} className={cn(mismatch && 'input-error')} autoComplete="new-password" />
      </Field>
      <button type="submit" disabled={mutation.isPending || !form.currentPassword || form.newPassword.length < 8 || mismatch} className="btn btn-primary">
        {mutation.isPending && <Spinner className="h-4 w-4" />} Update password
      </button>
    </form>
  );
}

/** "Chrome on Windows" style label from a user-agent string. */
function deviceLabel(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return { name: os ? `${browser} on ${os}` : browser, mobile: /Android|iPhone|iPad|Mobile/.test(ua) };
}

function Devices() {
  const queryClient = useQueryClient();
  const [confirmAll, setConfirmAll] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['sessions'], queryFn: () => api.get('/auth/sessions').then((r) => r.data.sessions) });
  const revoke = useMutation({
    mutationFn: (id) => api.delete(`/auth/sessions/${id}`),
    onSuccess: () => {
      toast.success('Device logged out');
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const everywhere = useMutation({
    mutationFn: logoutEverywhere,
    onSuccess: (message) => toast.success(message),
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <div className="mt-10 max-w-xl">
      <h3 className="font-semibold">Signed-in devices</h3>
      <p className="mt-1 text-sm muted">Log out a device you don't recognise, or everywhere at once.</p>
      {isLoading ? (
        <div className="mt-4"><Spinner className="h-5 w-5" /></div>
      ) : (
        <ul className="mt-4 divide-y divide-zinc-100 rounded-2xl border border-zinc-200 dark:divide-white/5 dark:border-white/10">
          {(data || []).map((s) => {
            const device = deviceLabel(s.userAgent);
            const Icon = device.mobile ? Smartphone : Monitor;
            return (
              <li key={s._id} className="flex items-center gap-3 px-4 py-3">
                <Icon className="h-5 w-5 shrink-0 text-zinc-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{device.name} {s.current && <span className="ml-1 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">This device</span>}</p>
                  <p className="text-xs muted">{s.ip || 'Unknown IP'} · active {timeAgo(s.lastUsedAt)} · signed in {formatDate(s.createdAt)}</p>
                </div>
                {!s.current && (
                  <button type="button" disabled={revoke.isPending} onClick={() => revoke.mutate(s._id)} className="btn btn-ghost btn-sm text-rose-600">Log out</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" onClick={() => setConfirmAll(true)} className="btn btn-secondary mt-4 text-rose-600">
        <LogOut className="h-4 w-4" /> Log out of all devices
      </button>
      <ConfirmDialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        onConfirm={() => everywhere.mutate()}
        loading={everywhere.isPending}
        danger
        title="Log out of all devices?"
        description="Every session ends, including this one. You'll need to sign in again everywhere."
        confirmLabel="Log out everywhere"
      />
    </div>
  );
}

function SecurityTab() {
  return (
    <>
      <Security />
      <Devices />
    </>
  );
}

const TABS = [
  { id: 'profile', label: 'Profile', icon: User, component: Profile },
  { id: 'addresses', label: 'Addresses', icon: MapPin, component: Addresses },
  { id: 'wishlist', label: 'Wishlist', icon: Heart, component: Wishlist, customerOnly: true },
  { id: 'security', label: 'Security', icon: KeyRound, component: SecurityTab },
];

export default function Account() {
  const user = useAuth((s) => s.user);
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((t) => !t.customerOnly || user.role === 'customer');
  const active = tabs.find((t) => t.id === params.get('tab')) || tabs[0];
  const Active = active.component;

  return (
    <div className="container-page py-8">
      <h1 className="font-display text-3xl font-bold tracking-tight">My account</h1>
      <div className="mt-6 grid gap-6 lg:grid-cols-[240px_1fr]">
        <nav className="card flex gap-1 overflow-x-auto p-2 scrollbar-none lg:flex-col lg:self-start">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setParams({ tab: id })}
              className={cn('relative flex shrink-0 items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-semibold transition', active.id === id ? 'text-brand-700 dark:text-white' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-white/5')}
            >
              {active.id === id && <motion.span layoutId="account-tab" className="absolute inset-0 rounded-xl bg-brand-50 dark:bg-brand-500/15" />}
              <Icon className="relative h-4 w-4" />
              <span className="relative">{label}</span>
            </button>
          ))}
        </nav>
        <AnimatePresence mode="wait">
          <motion.div key={active.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className={active.id === 'wishlist' ? '' : 'card p-6'}>
            <Active />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
