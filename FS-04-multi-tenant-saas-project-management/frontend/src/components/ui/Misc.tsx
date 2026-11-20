import { LoaderCircle, User } from "lucide-react";
import type { ReactNode } from "react";
import { cn, readableOn } from "@/lib/utils";
import type { UserMini } from "@/types";

const avatarSizes = {
  xs: "size-5 text-[9px]",
  sm: "size-6 text-[10px]",
  md: "size-8 text-xs",
  lg: "size-10 text-sm",
  xl: "size-16 text-xl",
};

export function Avatar({
  user, size = "sm", className, ring,
}: {
  user: Pick<UserMini, "display_name" | "initials" | "avatar_color"> | null | undefined;
  size?: keyof typeof avatarSizes;
  className?: string;
  ring?: boolean;
}) {
  if (!user) {
    return (
      <span
        title="Unassigned"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-slate-300 text-slate-400 dark:border-slate-600",
          avatarSizes[size],
          className,
        )}
      >
        <User className="size-[60%]" />
      </span>
    );
  }
  return (
    <span
      title={user.display_name}
      style={readableOn(user.avatar_color)}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight select-none",
        ring && "ring-2 ring-white dark:ring-slate-900",
        avatarSizes[size],
        className,
      )}
    >
      {user.initials}
    </span>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium", className)}>
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cn("size-5 animate-spin text-brand-500", className)} />;
}

export function PageLoader() {
  return (
    <div className="flex h-full min-h-60 items-center justify-center">
      <Spinner className="size-7" />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-slate-200/70 dark:bg-slate-800", className)} />;
}

export function EmptyState({
  icon, title, description, action, className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      {icon && (
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 ring-8 ring-brand-50/50 dark:bg-brand-500/10 dark:text-brand-400 dark:ring-brand-500/5">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-slate-200 bg-slate-50 px-1 font-sans text-[10px] font-medium text-slate-500",
        "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function ProgressBar({ value, className, color = "bg-emerald-500" }: { value: number; className?: string; color?: string }) {
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800", className)}>
      <div className={cn("h-full rounded-full transition-all duration-500", color)} style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden>
        <defs>
          <linearGradient id="fb-logo" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#6366f1" />
            <stop offset="1" stopColor="#a855f7" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="8" fill="url(#fb-logo)" />
        <rect x="7" y="8" width="5" height="16" rx="1.5" fill="#fff" />
        <rect x="14" y="8" width="5" height="11" rx="1.5" fill="#fff" opacity=".85" />
        <rect x="21" y="8" width="5" height="7" rx="1.5" fill="#fff" opacity=".7" />
      </svg>
      <span>FlowBoard</span>
    </span>
  );
}
