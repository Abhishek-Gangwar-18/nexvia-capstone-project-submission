import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { refreshMe } from '../../lib/session';
import { PageHeader } from '../../components/layout/DashboardLayout';
import { PageLoader, Spinner } from '../../components/ui/Feedback';
import { BusinessSection, EMPTY_STORE, PayoutSection, StoreSection, storePayload, validateStore } from './StoreForm';

export default function StoreSettings() {
  const { data: vendor, isLoading, refetch } = useQuery({ queryKey: ['vendor-store'], queryFn: () => api.get('/vendor/store').then((r) => r.data.vendor) });
  const [form, setForm] = useState(EMPTY_STORE);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (vendor) {
      setForm({
        ...EMPTY_STORE,
        ...Object.fromEntries(Object.keys(EMPTY_STORE).map((k) => [k, vendor[k] ?? EMPTY_STORE[k]])),
        address: { ...EMPTY_STORE.address, ...vendor.address },
        bank: { ...EMPTY_STORE.bank },
      });
    }
  }, [vendor]);

  if (isLoading) return <PageLoader />;

  const save = async (e) => {
    e.preventDefault();
    const found = validateStore(form, ['store', 'business', 'payout'], { bankRequired: false });
    setErrors(found);
    if (Object.keys(found).length) return toast.error('Please fix the highlighted fields');
    setSaving(true);
    try {
      await api.put('/vendor/store', storePayload(form));
      await Promise.all([refreshMe(), refetch()]);
      toast.success('Store settings saved');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
    return undefined;
  };

  const saveButton = (
    <button type="submit" disabled={saving} className="btn btn-primary">
      {saving ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />} Save changes
    </button>
  );

  return (
    <form onSubmit={save} noValidate className="space-y-6">
      <PageHeader title="Store settings" description="Branding, business details and payout preferences." actions={saveButton} />
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="card p-6">
          <h2 className="mb-5 font-semibold">Branding</h2>
          <StoreSection form={form} setForm={setForm} errors={errors} />
        </div>
        <div className="space-y-6">
          <div className="card p-6">
            <h2 className="mb-5 font-semibold">Business details</h2>
            <BusinessSection form={form} setForm={setForm} errors={errors} />
          </div>
          <div className="card p-6">
            <h2 className="font-semibold">Payouts</h2>
            <p className="mb-5 text-xs muted">
              Platform commission on your sales: <span className="font-semibold">{vendor.commissionRate ?? 'default'}{vendor.commissionRate !== null ? '%' : ' rate'}</span> (set by Vendora)
            </p>
            <PayoutSection form={form} setForm={setForm} errors={errors} currentBank={vendor.bank} />
          </div>
        </div>
      </div>
      <div className="flex justify-end">{saveButton}</div>
    </form>
  );
}
