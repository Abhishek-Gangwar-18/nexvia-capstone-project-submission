import { Field } from '../../components/ui/Controls';
import ImageUploader from '../../components/ui/ImageUploader';
import { cn } from '../../lib/format';

export const EMPTY_STORE = {
  storeName: '',
  tagline: '',
  description: '',
  logo: '',
  banner: '',
  email: '',
  phone: '',
  gstin: '',
  address: { line1: '', city: '', state: '', pincode: '' },
  bank: { accountHolder: '', accountNumber: '', ifsc: '' },
};

/** Client-side mirror of the API's onboarding rules, grouped by form section. */
export function validateStore(form, sections, { bankRequired = true } = {}) {
  const e = {};
  if (sections.includes('store')) {
    if (form.storeName.trim().length < 3) e.storeName = 'Store name must be at least 3 characters';
  }
  if (sections.includes('business')) {
    if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = 'Enter a valid business email';
    if (!/^[0-9+\-\s]{8,15}$/.test(form.phone)) e.phone = 'Enter a valid phone number';
    if (form.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(form.gstin.toUpperCase())) e.gstin = 'GSTIN must be 15 characters';
    if (form.address.line1.trim().length < 3) e['address.line1'] = 'Business address is required';
    if (form.address.city.trim().length < 2) e['address.city'] = 'City is required';
    if (form.address.state.trim().length < 2) e['address.state'] = 'State is required';
    if (!/^\d{6}$/.test(form.address.pincode)) e['address.pincode'] = 'Pincode must be 6 digits';
  }
  if (sections.includes('payout')) {
    const bank = form.bank;
    const touched = bank.accountHolder || bank.accountNumber || bank.ifsc;
    if (bankRequired || touched) {
      if (bank.accountHolder.trim().length < 2) e['bank.accountHolder'] = 'Account holder name is required';
      if (!/^\d{9,18}$/.test(bank.accountNumber)) e['bank.accountNumber'] = 'Account number must be 9–18 digits';
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bank.ifsc.toUpperCase())) e['bank.ifsc'] = 'Enter a valid IFSC code (e.g. HDFC0001234)';
    }
  }
  return e;
}

/** Builds the API payload; the bank block is only sent when filled in. */
export function storePayload(form, { includeBank = true } = {}) {
  const bankFilled = form.bank.accountHolder && form.bank.accountNumber && form.bank.ifsc;
  return {
    storeName: form.storeName.trim(),
    tagline: form.tagline.trim(),
    description: form.description.trim(),
    logo: form.logo,
    banner: form.banner,
    email: form.email.trim(),
    phone: form.phone.trim(),
    gstin: form.gstin.trim().toUpperCase(),
    address: form.address,
    ...(includeBank && bankFilled ? { bank: { ...form.bank, ifsc: form.bank.ifsc.toUpperCase() } } : {}),
  };
}

export function StoreSection({ form, setForm, errors }) {
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  return (
    <div className="space-y-4">
      <Field label="Store name" error={errors.storeName} required>
        <input value={form.storeName} onChange={set('storeName')} className={cn('input', errors.storeName && 'input-error')} placeholder="e.g. Handloom Heritage" />
      </Field>
      <Field label="Tagline" hint="One line shoppers see under your store name">
        <input value={form.tagline} onChange={set('tagline')} maxLength={120} className="input" placeholder="Handwoven sarees from Kanchipuram" />
      </Field>
      <Field label="About your store">
        <textarea value={form.description} onChange={set('description')} rows={4} maxLength={2000} className="input resize-none" placeholder="Tell customers what makes your products special" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Logo">
          <ImageUploader single folder="stores" value={form.logo ? [{ url: form.logo }] : []} onChange={(files) => setForm((f) => ({ ...f, logo: files[0]?.url || '' }))} />
        </Field>
        <Field label="Banner">
          <ImageUploader single folder="stores" value={form.banner ? [{ url: form.banner }] : []} onChange={(files) => setForm((f) => ({ ...f, banner: files[0]?.url || '' }))} />
        </Field>
      </div>
    </div>
  );
}

export function BusinessSection({ form, setForm, errors }) {
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const setAddress = (key) => (e) => setForm((f) => ({ ...f, address: { ...f.address, [key]: e.target.value } }));
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Business email" error={errors.email} required>
          <input type="email" value={form.email} onChange={set('email')} className={cn('input', errors.email && 'input-error')} />
        </Field>
        <Field label="Business phone" error={errors.phone} required>
          <input value={form.phone} onChange={set('phone')} className={cn('input', errors.phone && 'input-error')} placeholder="98765 43210" />
        </Field>
      </div>
      <Field label="GSTIN" error={errors.gstin} hint="Optional — 15-character GST number">
        <input value={form.gstin} onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))} maxLength={15} className={cn('input font-mono uppercase', errors.gstin && 'input-error')} placeholder="27ABCDE1234F1Z5" />
      </Field>
      <Field label="Business address" error={errors['address.line1']} required>
        <input value={form.address.line1} onChange={setAddress('line1')} className={cn('input', errors['address.line1'] && 'input-error')} placeholder="Shop / warehouse address" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="City" error={errors['address.city']} required>
          <input value={form.address.city} onChange={setAddress('city')} className={cn('input', errors['address.city'] && 'input-error')} />
        </Field>
        <Field label="State" error={errors['address.state']} required>
          <input value={form.address.state} onChange={setAddress('state')} className={cn('input', errors['address.state'] && 'input-error')} />
        </Field>
        <Field label="Pincode" error={errors['address.pincode']} required>
          <input value={form.address.pincode} onChange={setAddress('pincode')} maxLength={6} inputMode="numeric" className={cn('input', errors['address.pincode'] && 'input-error')} />
        </Field>
      </div>
    </div>
  );
}

export function PayoutSection({ form, setForm, errors, currentBank }) {
  const setBank = (key) => (e) => setForm((f) => ({ ...f, bank: { ...f.bank, [key]: e.target.value } }));
  return (
    <div className="space-y-4">
      {currentBank?.accountNumberMasked && (
        <div className="rounded-2xl bg-zinc-50 p-4 text-sm dark:bg-white/[0.03]">
          <p className="font-semibold">Current payout account</p>
          <p className="muted">
            {currentBank.accountHolder} · <span className="font-mono">{currentBank.accountNumberMasked}</span> · {currentBank.ifsc}
          </p>
          <p className="mt-1 text-xs muted">Fill the fields below only if you want to change it.</p>
        </div>
      )}
      <Field label="Account holder name" error={errors['bank.accountHolder']} required={!currentBank}>
        <input value={form.bank.accountHolder} onChange={setBank('accountHolder')} className={cn('input', errors['bank.accountHolder'] && 'input-error')} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Account number" error={errors['bank.accountNumber']} required={!currentBank}>
          <input value={form.bank.accountNumber} onChange={(e) => setForm((f) => ({ ...f, bank: { ...f.bank, accountNumber: e.target.value.replace(/\D/g, '') } }))} inputMode="numeric" maxLength={18} className={cn('input font-mono', errors['bank.accountNumber'] && 'input-error')} />
        </Field>
        <Field label="IFSC" error={errors['bank.ifsc']} required={!currentBank}>
          <input value={form.bank.ifsc} onChange={(e) => setForm((f) => ({ ...f, bank: { ...f.bank, ifsc: e.target.value.toUpperCase() } }))} maxLength={11} className={cn('input font-mono uppercase', errors['bank.ifsc'] && 'input-error')} placeholder="HDFC0001234" />
        </Field>
      </div>
      <p className="rounded-xl bg-zinc-50 p-3 text-xs muted dark:bg-white/[0.03]">
        Once your store is approved, you can connect a Stripe account under <span className="font-semibold">Payouts</span> for automatic transfers.
        Without one, Vendora settles your earnings to this bank account.
      </p>
    </div>
  );
}
