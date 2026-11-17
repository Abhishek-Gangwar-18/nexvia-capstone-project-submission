import type * as React from 'react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, X } from 'lucide-react';
import { cn } from '../../lib/format';
import { Spinner } from './Feedback';

/** `bare` drops the header bar and body padding (only a floating close button), for custom layouts. */
interface ModalProps {
  open?: boolean;
  onClose?: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: string;
  bare?: boolean;
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md', bare = false }: ModalProps) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);

  const widths = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center p-0 sm:items-center sm:p-4">
          <motion.div
            className="absolute inset-0 bg-zinc-950/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={{ opacity: 0, y: 40, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 30, scale: 0.97 }}
            transition={{ type: 'spring', damping: 28, stiffness: 340 }}
            className={cn(
              'relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl ring-1 ring-zinc-200 sm:rounded-3xl dark:bg-surface-dark dark:ring-white/10',
              widths[size],
            )}
          >
            {bare && onClose && (
              <button type="button" onClick={onClose} className="btn-icon absolute top-3 right-3 z-10 h-9 w-9" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            )}
            {!bare && (title || onClose) && (
              <div className="flex items-start justify-between gap-4 border-b border-zinc-100 px-6 py-4 dark:border-white/[0.06]">
                <div>
                  {title && <h2 className="font-display text-lg font-bold">{title}</h2>}
                  {description && <p className="mt-0.5 text-sm muted">{description}</p>}
                </div>
                {onClose && (
                  <button type="button" onClick={onClose} className="btn-icon -mr-2 h-9 w-9" aria-label="Close">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            )}
            <div className={cn('flex-1 overflow-y-auto', !bare && 'px-6 py-5')}>{children}</div>
            {footer && <div className="flex justify-end gap-2 border-t border-zinc-100 bg-zinc-50/60 px-6 py-4 dark:border-white/[0.06] dark:bg-white/[0.02]">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

interface ConfirmDialogProps {
  open?: boolean;
  onClose?: () => void;
  onConfirm?: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: React.ReactNode;
  danger?: boolean;
  loading?: boolean;
  children?: React.ReactNode;
}

export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = 'Confirm', danger = false, loading = false, children }: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={loading ? undefined : onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button type="button" className={cn('btn', danger ? 'btn-danger' : 'btn-primary')} onClick={onConfirm} disabled={loading}>
            {loading && <Spinner className="h-4 w-4" />} {confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex gap-4">
        <div
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl',
            danger ? 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300' : 'bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300',
          )}
        >
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-bold">{title}</h3>
          {description && <p className="mt-1 text-sm muted">{description}</p>}
          {children}
        </div>
      </div>
    </Modal>
  );
}

/** ConfirmDialog that asks for a required reason; onConfirm receives the trimmed text. */
interface ReasonDialogProps {
  open?: boolean;
  onClose?: () => void;
  onConfirm?: (reason: string) => void;
  label?: React.ReactNode;
  placeholder?: string;
  [key: string]: any;
}

export function ReasonDialog({ open, onClose, onConfirm, label = 'Reason', placeholder, ...props }: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const text = reason.trim();
  return (
    <ConfirmDialog open={open} onClose={onClose} onConfirm={() => text && onConfirm(text)} {...props}>
      <form className="mt-4" onSubmit={(e) => { e.preventDefault(); if (text) onConfirm(text); }}>
        <label className="label">{label}</label>
        <textarea autoFocus rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={placeholder} className="input resize-none" />
        {!text && <p className="mt-1 text-xs muted">A reason is required.</p>}
      </form>
    </ConfirmDialog>
  );
}
