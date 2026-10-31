import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title, description, actions, className, icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-4 px-4 pt-6 pb-4 sm:px-8", className)}>
      {icon}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-bold tracking-tight text-slate-900 sm:text-2xl dark:text-white">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("animate-fade-in px-4 pb-10 sm:px-8", className)}>{children}</div>;
}
