import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { CheckCircle2, CircleDashed, CreditCard, Database, HardDrive, RefreshCw, Save, Search, Zap } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { cn, formatDateTime, money } from '../../lib/format';

const CHANGE_LABELS = { commissionRate: 'Commission', shippingFee: 'Shipping fee', freeShippingThreshold: 'Free shipping above' };
const formatValue = (field, v) => (field === 'commissionRate' ? `${v}%` : money(v));
import { PageHeader } from '../../components/layout/DashboardLayout';
import { Field } from '../../components/ui/Controls';
import { PageLoader, Spinner } from '../../components/ui/Feedback';

function ServiceCard({ icon: Icon, name, live, liveLabel, fallbackLabel, detail, index }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05 }} className="flex items-start gap-3 rounded-2xl border border-zinc-200 p-4 dark:border-white/10">
      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', live ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300')}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{name}</p>
        <p className="flex items-center gap-1.5 text-sm">
          {live ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <CircleDashed className="h-3.5 w-3.5 text-amber-600" />}
          {live ? liveLabel : fallbackLabel}
        </p>
        {detail && <p className="mt-0.5 truncate text-xs muted">{detail}</p>}
      </div>
    </motion.div>
  );
}

export default function AdminSettings() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ['admin-settings'], queryFn: () => api.get('/admin/settings').then((r) => r.data) });
  const settings = { ...settingsQuery, data: settingsQuery.data?.settings };
  const history = settingsQuery.data?.history || [];
  const system = useQuery({ queryKey: ['admin-system'], queryFn: () => api.get('/admin/system').then((r) => r.data), refetchInterval: 15000 });
  const [form, setForm] = useState(null);

  useEffect(() => {
    if (settings.data) setForm({ commissionRate: settings.data.commissionRate, shippingFee: settings.data.shippingFee, freeShippingThreshold: settings.data.freeShippingThreshold });
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => api.patch('/admin/settings', { commissionRate: Number(form.commissionRate), shippingFee: Number(form.shippingFee), freeShippingThreshold: Number(form.freeShippingThreshold) }),
    onSuccess: () => {
      toast.success('Platform settings saved');
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const reindex = useMutation({
    mutationFn: () => api.post('/admin/search/reindex').then((r) => r.data),
    onSuccess: (data) => {
      toast.success(data.message);
      system.refetch();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (settings.isLoading || !form) return <PageLoader />;
  const s = system.data;
  const exampleOrder = 2000;
  const fee = (exampleOrder * Number(form.commissionRate || 0)) / 100;

  return (
    <div className="space-y-6">
      <PageHeader title="Settings & system" description="Commission, shipping rules and the health of every backing service." />

      <div className="grid gap-6 xl:grid-cols-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          className="card space-y-5 p-6"
        >
          <h2 className="font-semibold">Marketplace rules</h2>
          <Field label="Default commission (%)" hint="Applied to sellers without an override. Changes apply to new orders only.">
            <input type="number" min="0" max="50" step="0.5" value={form.commissionRate} onChange={(e) => setForm((f) => ({ ...f, commissionRate: e.target.value }))} className="input" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Shipping fee (₹)">
              <input type="number" min="0" value={form.shippingFee} onChange={(e) => setForm((f) => ({ ...f, shippingFee: e.target.value }))} className="input" />
            </Field>
            <Field label="Free shipping above (₹)">
              <input type="number" min="0" value={form.freeShippingThreshold} onChange={(e) => setForm((f) => ({ ...f, freeShippingThreshold: e.target.value }))} className="input" />
            </Field>
          </div>
          <div className="rounded-2xl bg-gradient-to-r from-brand-50 to-indigo-50 p-4 text-sm dark:from-brand-500/10 dark:to-indigo-500/5">
            <p className="font-semibold">Split preview for a {money(exampleOrder)} package</p>
            <div className="mt-3 flex h-3 overflow-hidden rounded-full">
              <div className="bg-emerald-500" style={{ width: `${100 - Number(form.commissionRate || 0)}%` }} />
              <div className="ml-0.5 bg-brand-600" style={{ width: `${Number(form.commissionRate || 0)}%` }} />
            </div>
            <div className="mt-2 flex justify-between text-xs">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Seller {money(exampleOrder - fee)}</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-brand-600" /> Vendora {money(fee)}</span>
            </div>
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={save.isPending} className="btn btn-primary">
              {save.isPending ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />} Save settings
            </button>
          </div>
          {history.length > 0 && (
            <div className="border-t border-zinc-100 pt-4 dark:border-white/5">
              <p className="text-sm font-semibold">Recent changes</p>
              <ul className="mt-2 space-y-1.5 text-xs">
                {history.map((h, i) => (
                  <li key={`${h.at}-${h.field}-${i}`} className="flex flex-wrap justify-between gap-2">
                    <span>
                      <span className="font-semibold">{CHANGE_LABELS[h.field] || h.field}</span>: {formatValue(h.field, h.from)} → {formatValue(h.field, h.to)}
                    </span>
                    <span className="muted">{h.by?.name || 'Admin'} · {formatDateTime(h.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </form>

        <div className="card space-y-4 p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold">System status</h2>
              <p className="text-xs muted">Live services vs. local development fallbacks · auto-refreshes</p>
            </div>
            <button type="button" onClick={() => system.refetch()} className="btn-icon h-9 w-9" aria-label="Refresh status">
              <RefreshCw className={cn('h-4 w-4', system.isFetching && 'animate-spin')} />
            </button>
          </div>
          {s ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <ServiceCard index={0} icon={Database} name="MongoDB" live={s.database.connected} liveLabel="Connected" fallbackLabel="Disconnected" detail={`${s.database.database} · ${s.database.transactions ? 'replica set, transactions on' : 'standalone'} · ${s.database.host}`} />
              <ServiceCard index={1} icon={Zap} name="Redis" live={s.cache.driver === 'redis' && s.cache.healthy} liveLabel="Connected (sessions, locks, rate limits, cache)" fallbackLabel={s.cache.driver === 'redis' ? 'Unreachable, reconnecting' : 'In-memory fallback'} detail={s.cache.driver === 'redis' ? 'Locks are refused and caches read MongoDB until it is back' : 'Set REDIS_URL to enable'} />
              <ServiceCard index={2} icon={Search} name="Elasticsearch" live={s.search.engine === 'elasticsearch'} liveLabel={`${s.search.documents ?? 0} docs indexed`} fallbackLabel={s.search.configured ? 'Unreachable, reconnecting' : 'MongoDB search fallback'} detail={s.search.configured ? (s.search.engine === 'elasticsearch' ? s.search.build || s.search.index : 'Search runs on MongoDB until it is back') : 'Set ELASTICSEARCH_NODE to enable'} />
              <ServiceCard index={3} icon={HardDrive} name="AWS S3" live={s.storage.driver === 's3'} liveLabel="Uploading to S3" fallbackLabel="Local disk fallback" detail="Set AWS_S3_BUCKET + keys to enable" />
              <ServiceCard index={4} icon={CreditCard} name="Stripe" live={s.payments.provider === 'stripe'} liveLabel="Payments + Connect payouts" fallbackLabel="Built-in test gateway" detail="Set STRIPE_SECRET_KEY / PUBLISHABLE_KEY to enable" />
            </div>
          ) : (
            <Spinner className="h-6 w-6 text-brand-600" />
          )}
          <div className="flex items-center justify-between rounded-2xl bg-zinc-50 p-4 dark:bg-white/[0.03]">
            <div className="text-sm">
              <p className="font-semibold">Rebuild search index</p>
              <p className="text-xs muted">Builds a fresh index from MongoDB and switches to it when complete; search keeps working meanwhile.</p>
            </div>
            <button type="button" onClick={() => reindex.mutate()} disabled={reindex.isPending || s?.search.engine !== 'elasticsearch'} className="btn btn-secondary btn-sm">
              {reindex.isPending ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />} Reindex
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
