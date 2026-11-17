import type * as React from 'react';
import { useState } from 'react';
import { Home, Briefcase, MapPin } from 'lucide-react';
import { cn } from '../../lib/format';
import { Field } from '../ui/Controls';
import { Spinner } from '../ui/Feedback';

const STATES = [
  'Andhra Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jammu & Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Odisha', 'Punjab', 'Rajasthan',
  'Tamil Nadu', 'Telangana', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

export const EMPTY_ADDRESS = { label: 'Home', fullName: '', phone: '', line1: '', line2: '', city: '', state: '', pincode: '', isDefault: false };

function validate(a) {
  const errors: Record<string, string> = {};
  if (a.fullName.trim().length < 2) errors.fullName = 'Enter the recipient’s name';
  if (!/^[0-9+\-\s]{8,15}$/.test(a.phone.trim())) errors.phone = 'Enter a valid phone number';
  if (a.line1.trim().length < 3) errors.line1 = 'Enter the house / street';
  if (a.city.trim().length < 2) errors.city = 'Enter the city';
  if (!a.state) errors.state = 'Choose a state';
  if (!/^\d{6}$/.test(a.pincode.trim())) errors.pincode = 'Pincode must be 6 digits';
  return errors;
}

interface AddressFormProps {
  initial?: any;
  onSubmit?: any;
  onCancel?: any;
  submitLabel?: any;
  saving?: any;
}

export default function AddressForm({ initial = EMPTY_ADDRESS, onSubmit, onCancel, submitLabel = 'Save address', saving }: AddressFormProps) {
  const [form, setForm] = useState({ ...EMPTY_ADDRESS, ...initial });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    const { _id, ...payload } = form;
    onSubmit(payload);
  };

  const input = (key, props = {}) => <input value={form[key]} onChange={set(key)} className={cn('input', errors[key] && 'input-error')} {...props} />;

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="flex gap-2">
        {([
          ['Home', Home],
          ['Work', Briefcase],
          ['Other', MapPin],
        ] as [string, React.ElementType][]).map(([label, Icon]) => (
          <button key={label} type="button" onClick={() => setForm((f) => ({ ...f, label }))} className={cn('chip', form.label === label && 'chip-active')}>
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" error={errors.fullName} required>{input('fullName', { autoComplete: 'name' })}</Field>
        <Field label="Phone" error={errors.phone} required>{input('phone', { autoComplete: 'tel', inputMode: 'tel' })}</Field>
      </div>
      <Field label="House no., building, street" error={errors.line1} required>{input('line1', { autoComplete: 'address-line1' })}</Field>
      <Field label="Area, landmark (optional)">{input('line2', { autoComplete: 'address-line2' })}</Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="City" error={errors.city} required>{input('city', { autoComplete: 'address-level2' })}</Field>
        <Field label="State" error={errors.state} required>
          <select value={form.state} onChange={set('state')} className={cn('input', errors.state && 'input-error')}>
            <option value="">Select</option>
            {STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Pincode" error={errors.pincode} required>{input('pincode', { inputMode: 'numeric', maxLength: 6, autoComplete: 'postal-code' })}</Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.isDefault} onChange={set('isDefault')} className="h-4 w-4 rounded accent-brand-600" />
        Make this my default address
      </label>
      <div className="flex justify-end gap-2 pt-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn btn-ghost">Cancel</button>
        )}
        <button type="submit" disabled={saving} className="btn btn-primary">
          {saving && <Spinner className="h-4 w-4" />} {submitLabel}
        </button>
      </div>
    </form>
  );
}
