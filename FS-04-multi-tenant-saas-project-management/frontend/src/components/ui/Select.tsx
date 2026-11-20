import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface Option<T> {
  value: T;
  label: string;
  icon?: ReactNode;
  hint?: string;
}

const buttonBase =
  "group flex w-full cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 text-left text-sm shadow-xs transition " +
  "hover:border-slate-300 focus:outline-none data-focus:border-brand-500 data-focus:ring-4 data-focus:ring-brand-500/15 data-disabled:cursor-not-allowed data-disabled:opacity-60 " +
  "dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600";

const ghostButton =
  "group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-sm transition hover:bg-slate-100 focus:outline-none data-focus:bg-slate-100 " +
  "data-disabled:cursor-default data-disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:data-focus:bg-slate-800";

export const optionsPanel =
  "z-50 max-h-72 min-w-(--button-width) overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl shadow-slate-900/10 " +
  "[--anchor-gap:6px] focus:outline-none transition duration-100 ease-out data-closed:scale-95 data-closed:opacity-0 " +
  "dark:border-slate-700 dark:bg-slate-900 dark:shadow-black/40";

export const optionItem =
  "group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-slate-700 select-none " +
  "data-focus:bg-slate-100 data-focus:text-slate-900 dark:text-slate-300 dark:data-focus:bg-slate-800 dark:data-focus:text-white";

export function Select<T extends string | number | null>({
  value, onChange, options, placeholder = "Select…", disabled, className, buttonClassName, variant = "default", size = "md",
}: {
  value: T;
  onChange: (value: T) => void;
  options: Option<T>[];
  placeholder?: string;
  disabled?: boolean;
  /** Sizing/layout of the wrapper (e.g. "w-36"). */
  className?: string;
  /** Extra styling for the trigger button itself (colours, font…). */
  buttonClassName?: string;
  variant?: "default" | "ghost";
  size?: "sm" | "md";
}) {
  const selected = options.find((o) => o.value === value);
  return (
    <Listbox as="div" className={cn("min-w-0", className)} value={value} onChange={onChange} disabled={disabled}>
      <ListboxButton
        className={cn(variant === "ghost" ? ghostButton : buttonBase, size === "sm" ? "h-8" : "h-9", buttonClassName)}
      >
        {selected?.icon}
        <span className={cn("flex-1 truncate", !selected && "text-slate-400")}>{selected?.label ?? placeholder}</span>
        {!disabled && (
          <ChevronDown className="size-4 shrink-0 text-slate-400 transition group-data-open:rotate-180" />
        )}
      </ListboxButton>
      <ListboxOptions anchor="bottom start" transition className={optionsPanel}>
        {options.map((option) => (
          <ListboxOption key={String(option.value)} value={option.value} className={optionItem}>
            {option.icon}
            <span className="flex-1 truncate">{option.label}</span>
            {option.hint && <span className="text-xs text-slate-400">{option.hint}</span>}
            <Check className="invisible size-4 text-brand-600 group-data-selected:visible dark:text-brand-400" />
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}

export function MultiSelect<T extends string | number>({
  value, onChange, options, placeholder = "None", disabled, renderValue, className, buttonClassName,
}: {
  value: T[];
  onChange: (value: T[]) => void;
  options: Option<T>[];
  placeholder?: string;
  disabled?: boolean;
  renderValue?: (selected: Option<T>[]) => ReactNode;
  className?: string;
  buttonClassName?: string;
}) {
  const selected = options.filter((o) => value.includes(o.value));
  return (
    <Listbox as="div" className={cn("min-w-0", className)} value={value} onChange={onChange} multiple disabled={disabled}>
      <ListboxButton className={cn(ghostButton, "min-h-8 py-1", buttonClassName)}>
        <span className="flex flex-1 flex-wrap gap-1">
          {selected.length ? (
            renderValue ? renderValue(selected) : selected.map((o) => o.label).join(", ")
          ) : (
            <span className="text-slate-400">{placeholder}</span>
          )}
        </span>
      </ListboxButton>
      <ListboxOptions anchor="bottom start" transition className={optionsPanel}>
        {options.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No options</div>}
        {options.map((option) => (
          <ListboxOption key={String(option.value)} value={option.value} className={optionItem}>
            {option.icon}
            <span className="flex-1 truncate">{option.label}</span>
            <Check className="invisible size-4 text-brand-600 group-data-selected:visible dark:text-brand-400" />
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}
