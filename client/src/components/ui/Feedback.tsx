import type { ApiError } from '../../types';
import type * as React from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/format';
import { errorMessage } from '../../lib/api';

interface SpinnerProps {
  className?: string;
}

export function Spinner({ className }: SpinnerProps) {
  return (
    <svg className={cn('h-5 w-5 animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

interface PageLoaderProps {
  label?: React.ReactNode;
}

export function PageLoader({ label = 'Loading…' }: PageLoaderProps) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-zinc-500">
      <Spinner className="h-8 w-8 text-brand-600" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div className={cn('relative overflow-hidden rounded-xl bg-zinc-200/70 dark:bg-white/[0.06]', className)}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/50 to-transparent dark:via-white/[0.06]" />
    </div>
  );
}

interface EmptyStateProps {
  icon?: React.ElementType;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn('flex flex-col items-center justify-center px-6 py-16 text-center', className)}
    >
      {Icon && (
        <div className="relative mb-5">
          <div className="absolute inset-0 rounded-full bg-brand-500/20 blur-2xl" />
          <div className="relative flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-brand-50 to-indigo-100 text-brand-600 ring-1 ring-brand-200/60 dark:from-brand-500/15 dark:to-indigo-500/10 dark:text-brand-300 dark:ring-brand-400/20">
            <Icon className="h-9 w-9" strokeWidth={1.6} />
          </div>
        </div>
      )}
      <h3 className="font-display text-xl font-bold text-zinc-900 dark:text-white">{title}</h3>
      {description && <p className="mt-2 max-w-sm text-sm muted">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </motion.div>
  );
}

interface ErrorStateProps {
  error?: ApiError | Error | null;
  onRetry?: () => unknown;
  className?: string;
}

export function ErrorState({ error, onRetry, className }: ErrorStateProps) {
  return (
    <div className={cn('card flex flex-col items-center gap-3 px-6 py-12 text-center', className)}>
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <p className="font-semibold">Something went wrong</p>
      <p className="max-w-md text-sm muted">{errorMessage(error)}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn btn-secondary btn-sm mt-1">
          <RefreshCw className="h-3.5 w-3.5" /> Try again
        </button>
      )}
    </div>
  );
}
