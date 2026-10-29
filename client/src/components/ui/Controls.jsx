import { useId, useState } from 'react';
import { motion } from 'framer-motion';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '../../lib/format';

export function Switch({ checked, onChange, disabled, label, size = 'md' }) {
  const dims = size === 'sm' ? ['h-5 w-9', 'h-4 w-4', 16] : ['h-6 w-11', 'h-5 w-5', 20];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 disabled:opacity-50',
        dims[0],
        checked ? 'bg-gradient-to-r from-brand-500 to-indigo-500' : 'bg-zinc-300 dark:bg-white/15',
      )}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 600, damping: 32 }}
        className={cn('rounded-full bg-white shadow-sm', dims[1])}
        style={{ marginLeft: checked ? 'auto' : 0 }}
      />
    </button>
  );
}

/** Pill tabs with an animated active indicator. */
export function Segmented({ options, value, onChange, className, size = 'md' }) {
  const id = useId();
  return (
    <div className={cn('inline-flex rounded-2xl bg-zinc-100 p-1 dark:bg-white/[0.06]', className)}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              'relative rounded-xl font-semibold whitespace-nowrap transition-colors',
              size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm',
              active ? 'text-zinc-900 dark:text-white' : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-xl bg-white shadow-sm ring-1 ring-zinc-200/70 dark:bg-white/10 dark:ring-white/10"
                transition={{ type: 'spring', stiffness: 500, damping: 36 }}
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {opt.icon && <opt.icon className="h-4 w-4" />}
              {opt.label}
              {opt.count !== undefined && (
                <span className={cn('rounded-full px-1.5 text-[10px] font-bold', active ? 'bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-200' : 'bg-zinc-200 text-zinc-600 dark:bg-white/10 dark:text-zinc-400')}>
                  {opt.count}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Password input, hidden by default, with an eye button to show or hide it. `icon` adds a leading icon. */
export function PasswordInput({ icon: Icon, className, wrapperClassName, ...props }) {
  const [show, setShow] = useState(false);
  return (
    <div className={cn('relative', wrapperClassName)}>
      {Icon && <Icon className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-zinc-400" />}
      <input {...props} type={show ? 'text' : 'password'} className={cn('input pr-10', Icon && 'pl-10', className)} />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute top-1/2 right-3 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
        aria-label={show ? 'Hide password' : 'Show password'}
        aria-pressed={show}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

/** Label + control + error message. Pass the control as children. */
export function Field({ label, error, hint, children, className, required }) {
  return (
    <div className={className}>
      {label && (
        <label className="label">
          {label} {required && <span className="text-rose-500">*</span>}
        </label>
      )}
      {children}
      {error ? <p className="field-error">{error}</p> : hint ? <p className="mt-1 text-xs muted">{hint}</p> : null}
    </div>
  );
}
