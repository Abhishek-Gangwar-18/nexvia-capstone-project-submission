import type { ComponentProps, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "xs" | "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary:
    "bg-brand-600 text-white shadow-sm shadow-brand-600/20 hover:bg-brand-700 active:bg-brand-800 dark:bg-brand-600 dark:hover:bg-brand-500",
  secondary:
    "border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
  ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100",
  subtle: "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
  danger: "bg-rose-600 text-white shadow-sm hover:bg-rose-700 active:bg-rose-800",
};

const sizes: Record<Size, string> = {
  xs: "h-7 px-2 text-xs gap-1 rounded-md",
  sm: "h-8 px-3 text-sm gap-1.5 rounded-lg",
  md: "h-9 px-4 text-sm gap-2 rounded-lg",
  lg: "h-11 px-5 text-sm gap-2 rounded-xl",
};

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center font-medium whitespace-nowrap transition-all duration-150 select-none",
        "disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  className, label, ...props
}: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-slate-500 transition-colors",
        "hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100",
        "disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}
