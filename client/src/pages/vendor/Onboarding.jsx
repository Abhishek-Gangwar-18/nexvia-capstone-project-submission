import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Building2, Check, Clock, Landmark, Pencil, RefreshCw, ShieldX, Sparkles, Store } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { refreshMe } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/format';
import { useAuth } from '../../store/auth';
import { Spinner } from '../../components/ui/Feedback';
import { StoreAvatar } from '../../components/ui/Brand';
import StatusBadge from '../../components/ui/StatusBadge';
import { BusinessSection, EMPTY_STORE, PayoutSection, StoreSection, storePayload, validateStore } from './StoreForm';

const STEPS = [
  { id: 'store', title: 'Your store', icon: Store, text: 'Name, story and branding' },
  { id: 'business', title: 'Business details', icon: Building2, text: 'Contact, GST and address' },
  { id: 'payout', title: 'Payouts', icon: Landmark, text: 'Where we send your earnings' },
  { id: 'review', title: 'Review & submit', icon: Check, text: 'Send for approval' },
];

function fromVendor(vendor) {
  return {
    ...EMPTY_STORE,
    ...Object.fromEntries(Object.keys(EMPTY_STORE).map((k) => [k, vendor[k] ?? EMPTY_STORE[k]])),
    address: { ...EMPTY_STORE.address, ...vendor.address },
    bank: { ...EMPTY_STORE.bank },
  };
}

function Wizard({ initial, existing, onDone }) {
  const user = useAuth((s) => s.user);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(initial || { ...EMPTY_STORE, email: user.email, phone: user.phone || '', bank: { ...EMPTY_STORE.bank, accountHolder: user.name } });
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const current = STEPS[step];

  const next = () => {
    const found = validateStore(form, [current.id], { bankRequired: !existing });
    setErrors(found);
    if (Object.keys(found).length) return toast.error('Please fix the highlighted fields');
    return setStep((s) => s + 1);
  };

  const submit = async () => {
    const options = { bankRequired: !existing };
    const found = validateStore(form, ['store', 'business', 'payout'], options);
    if (Object.keys(found).length) {
      setErrors(found);
      const firstInvalid = STEPS.findIndex((s) => s.id !== 'review' && Object.keys(validateStore(form, [s.id], options)).length);
      setStep(Math.max(0, firstInvalid));
      return;
    }
    setSubmitting(true);
    try {
      if (existing) await api.patch('/vendor/store', storePayload(form));
      else await api.post('/vendor/onboard', storePayload(form));
      await refreshMe({ fresh: true });
      toast.success(existing ? 'Application updated' : 'Application submitted!');
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      <ol className="card space-y-1 self-start p-3">
        {STEPS.map((s, i) => {
          const done = i < step;
          const active = i === step;
          return (
            <li key={s.id}>
              <button
                type="button"
                disabled={i > step}
                onClick={() => setStep(i)}
                className={cn('flex w-full items-center gap-3 rounded-xl p-3 text-left transition', active ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-zinc-50 disabled:hover:bg-transparent dark:hover:bg-white/5')}
              >
                <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition', done ? 'bg-emerald-500 text-white' : active ? 'bg-gradient-to-br from-brand-500 to-indigo-600 text-white' : 'bg-zinc-100 text-zinc-400 dark:bg-white/10')}>
                  {done ? <Check className="h-4 w-4" /> : <s.icon className="h-4 w-4" />}
                </span>
                <span>
                  <span className={cn('block text-sm font-semibold', !active && !done && 'text-zinc-400')}>{s.title}</span>
                  <span className="block text-xs muted">{s.text}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="card overflow-hidden">
        <div className="h-1 bg-zinc-100 dark:bg-white/5">
          <motion.div className="h-full bg-gradient-to-r from-brand-500 to-indigo-500" animate={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
        </div>
        <div className="p-6">
          <h2 className="font-display text-xl font-bold">{current.title}</h2>
          <p className="mb-6 text-sm muted">{current.text}</p>
          <AnimatePresence mode="wait">
            <motion.div key={current.id} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.2 }}>
              {current.id === 'store' && <StoreSection form={form} setForm={setForm} errors={errors} />}
              {current.id === 'business' && <BusinessSection form={form} setForm={setForm} errors={errors} />}
              {current.id === 'payout' && <PayoutSection form={form} setForm={setForm} errors={errors} currentBank={existing?.bank} />}
              {current.id === 'review' && (
                <div className="space-y-4">
                  <div className="flex items-center gap-4 rounded-2xl bg-zinc-50 p-4 dark:bg-white/[0.03]">
                    <StoreAvatar store={{ storeName: form.storeName, logo: form.logo }} size="h-14 w-14" />
                    <div>
                      <p className="font-display text-lg font-bold">{form.storeName}</p>
                      <p className="text-sm muted">{form.tagline || 'No tagline'}</p>
                    </div>
                  </div>
                  <dl className="grid gap-3 text-sm sm:grid-cols-2">
                    {[
                      ['Email', form.email],
                      ['Phone', form.phone],
                      ['GSTIN', form.gstin || '—'],
                      ['Address', `${form.address.line1}, ${form.address.city}, ${form.address.state} ${form.address.pincode}`],
                      ['Bank account', form.bank.accountNumber ? `${form.bank.accountHolder} · ••••${form.bank.accountNumber.slice(-4)} · ${form.bank.ifsc}` : existing?.bank?.accountNumberMasked ? 'Unchanged' : '—'],
                      ['Automatic payouts', 'Connect Stripe under Payouts after approval (optional)'],
                    ].map(([k, v]) => (
                      <div key={k} className="rounded-xl border border-zinc-100 p-3 dark:border-white/5">
                        <dt className="text-xs muted">{k}</dt>
                        <dd className="mt-0.5 font-medium break-words">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="rounded-xl bg-brand-50 p-3 text-xs text-brand-800 dark:bg-brand-500/10 dark:text-brand-200">
                    An admin reviews every application, usually within a day. Once approved you can list products and receive orders.
                  </p>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
          <div className="mt-8 flex justify-between">
            <button type="button" onClick={() => setStep((s) => s - 1)} disabled={step === 0} className="btn btn-ghost">
              <ArrowLeft className="h-4 w-4" /> Back
            </button>
            {current.id === 'review' ? (
              <button type="button" onClick={submit} disabled={submitting} className="btn btn-primary">
                {submitting ? <Spinner className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />} {existing ? 'Save & resubmit' : 'Submit application'}
              </button>
            ) : (
              <button type="button" onClick={next} className="btn btn-primary">
                Continue <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusScreen({ vendor, onEdit }) {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(false);
  const rejected = vendor.status === 'rejected';
  const suspended = vendor.status === 'suspended';

  const check = async () => {
    setChecking(true);
    try {
      const me = await refreshMe();
      if (me.vendor?.status === 'approved') {
        toast.success('You’re approved! Welcome to Seller Hub 🎉');
        navigate('/vendor');
      } else toast('Still under review — we’ll be quick!', { icon: '⏳' });
    } finally {
      setChecking(false);
    }
  };

  const steps = [
    { label: 'Application submitted', done: true, at: vendor.createdAt },
    { label: rejected ? 'Changes requested' : suspended ? 'Store suspended' : 'Under review by admin', done: rejected || suspended, active: !rejected && !suspended, bad: rejected || suspended },
    { label: 'Store goes live', done: false },
  ];

  return (
    <div className="mx-auto max-w-2xl">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="card overflow-hidden">
        <div className={cn('relative px-8 py-10 text-center text-white', rejected || suspended ? 'bg-gradient-to-br from-rose-500 to-orange-500' : 'bg-gradient-to-br from-brand-600 to-indigo-700')}>
          <div className="absolute inset-0 bg-grid opacity-20" />
          <motion.div animate={rejected || suspended ? {} : { rotate: [0, 180, 180, 360] }} transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }} className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-white/20">
            {rejected || suspended ? <ShieldX className="h-8 w-8" /> : <Clock className="h-8 w-8" />}
          </motion.div>
          <h1 className="relative mt-4 font-display text-2xl font-bold">
            {rejected ? 'Your application needs changes' : suspended ? 'Your store is suspended' : 'Application under review'}
          </h1>
          <p className="relative mt-2 text-sm text-white/80">
            {rejected ? 'Update your details and resubmit — we’ll review it again.' : suspended ? 'Contact support to reactivate your store.' : 'Our team is verifying your store details. This usually takes less than a day.'}
          </p>
        </div>
        <div className="space-y-6 p-6">
          <div className="flex items-center gap-4">
            <StoreAvatar store={vendor} size="h-12 w-12" />
            <div className="flex-1">
              <p className="font-semibold">{vendor.storeName}</p>
              <p className="text-xs muted">{vendor.email}</p>
            </div>
            <StatusBadge status={vendor.status} pulse={vendor.status === 'pending'} />
          </div>
          {vendor.rejectionReason && (
            <div className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">
              <p className="font-semibold">Reviewer’s note</p>
              <p className="mt-1">{vendor.rejectionReason}</p>
            </div>
          )}
          <ol className="space-y-4">
            {steps.map((s) => (
              <li key={s.label} className="flex items-center gap-3">
                <span className={cn('relative flex h-8 w-8 items-center justify-center rounded-full', s.bad ? 'bg-rose-500 text-white' : s.done ? 'bg-emerald-500 text-white' : s.active ? 'bg-brand-600 text-white' : 'bg-zinc-100 text-zinc-400 dark:bg-white/10')}>
                  {s.active && <span className="absolute inset-0 animate-ping rounded-full bg-brand-500/40" />}
                  {s.bad ? <ShieldX className="h-4 w-4" /> : s.done ? <Check className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
                </span>
                <div>
                  <p className="text-sm font-semibold">{s.label}</p>
                  {s.at && <p className="text-xs muted">{formatDateTime(s.at)}</p>}
                </div>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-100 pt-5 dark:border-white/5">
            {!suspended && (
              <button type="button" onClick={onEdit} className="btn btn-secondary">
                <Pencil className="h-4 w-4" /> Edit application
              </button>
            )}
            {!rejected && !suspended && (
              <button type="button" onClick={check} disabled={checking} className="btn btn-primary">
                {checking ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />} Check status
              </button>
            )}
          </div>
          {!rejected && !suspended && (
            <p className="text-center text-xs muted">The marketplace admin approves new stores from Admin → Vendors.</p>
          )}
        </div>
      </motion.div>
    </div>
  );
}

export default function Onboarding() {
  const user = useAuth((s) => s.user);
  const [editing, setEditing] = useState(false);
  const vendor = user.vendor;

  if (vendor?.status === 'approved') return <Navigate to="/vendor" replace />;

  return (
    <div className="container-page py-8">
      {!vendor || editing ? (
        <>
          <div className="mb-6">
            <span className="text-xs font-bold tracking-[0.2em] text-brand-600 uppercase dark:text-brand-300">Seller onboarding</span>
            <h1 className="mt-1 font-display text-3xl font-bold tracking-tight">{vendor ? 'Update your application' : 'Set up your store'}</h1>
            <p className="mt-1 text-sm muted">Takes about 3 minutes. You can edit everything later.</p>
          </div>
          <Wizard initial={vendor ? fromVendor(vendor) : null} existing={vendor} onDone={() => setEditing(false)} />
        </>
      ) : (
        <StatusScreen vendor={vendor} onEdit={() => setEditing(true)} />
      )}
    </div>
  );
}
