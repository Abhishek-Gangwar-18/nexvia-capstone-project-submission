import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button, IconButton } from "./Button";

const widths = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };

export function Modal({
  open, onClose, title, description, children, footer, size = "md", icon,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof widths;
  icon?: ReactNode;
}) {
  return (
    <Dialog open={open} onClose={onClose} className="relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-slate-950/40 backdrop-blur-[2px] transition duration-200 data-closed:opacity-0"
      />
      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-start justify-center p-4 sm:pt-[10vh]">
          <DialogPanel
            transition
            className={cn(
              "w-full rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/5 transition duration-200 ease-out",
              "data-closed:translate-y-2 data-closed:scale-[0.98] data-closed:opacity-0",
              "dark:bg-slate-900 dark:ring-slate-700/60",
              widths[size],
            )}
          >
            <div className="flex items-start gap-3 px-6 pt-5 pb-1">
              {icon}
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</DialogTitle>
                {description && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>}
              </div>
              <IconButton label="Close" onClick={onClose} className="-mr-2 -mt-1">
                <X className="size-4" />
              </IconButton>
            </div>
            {children && <div className="px-6 py-4">{children}</div>}
            {footer && (
              <div className="flex flex-wrap items-center justify-end gap-2 rounded-b-2xl border-t border-slate-100 bg-slate-50/60 px-6 py-3.5 dark:border-slate-800 dark:bg-slate-900/60">
                {footer}
              </div>
            )}
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}

export function Drawer({
  open, onClose, children, label,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  label: string;
}) {
  return (
    <Dialog open={open} onClose={onClose} className="relative z-40">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-slate-950/30 transition duration-300 data-closed:opacity-0"
      />
      <div className="fixed inset-0 overflow-hidden">
        <div className="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-0 sm:pl-10">
          <DialogPanel
            transition
            aria-label={label}
            className="pointer-events-auto flex h-full w-screen max-w-4xl flex-col bg-white shadow-2xl transition duration-300 ease-out data-closed:translate-x-full dark:bg-slate-900"
          >
            {children}
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}

export function ConfirmDialog({
  open, onClose, onConfirm, title, description, confirmLabel = "Delete", loading, tone = "danger", children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  loading?: boolean;
  tone?: "danger" | "primary";
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={tone} loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
