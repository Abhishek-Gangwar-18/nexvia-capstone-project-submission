import { Menu, MenuButton, MenuItem, MenuItems, MenuSeparator } from "@headlessui/react";
import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface DropdownItem {
  label: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  hint?: ReactNode;
}

export function Dropdown({
  trigger, items, header, anchor = "bottom end", className,
}: {
  trigger: ReactNode;
  items: DropdownItem[];
  header?: ReactNode;
  anchor?: "bottom end" | "bottom start" | "top start" | "top end" | "right end";
  className?: string;
}) {
  return (
    <Menu>
      {/* The trigger (a <button>) is the menu button itself, so aria-expanded/aria-haspopup sit on the button and
          not on a role-less wrapper div. The div only handles layout. */}
      <div className={cn("inline-flex", className)}>
        <MenuButton as={Fragment}>{trigger}</MenuButton>
      </div>
      <MenuItems
        anchor={anchor}
        transition
        className={cn(
          "z-50 min-w-52 rounded-xl border border-slate-200 bg-white p-1 shadow-xl shadow-slate-900/10 [--anchor-gap:6px] focus:outline-none",
          "transition duration-100 ease-out data-closed:scale-95 data-closed:opacity-0",
          "dark:border-slate-700 dark:bg-slate-900 dark:shadow-black/40",
        )}
      >
        {header && <div className="px-2.5 pt-1.5 pb-2">{header}</div>}
        {items.map((item, index) =>
          item.separator ? (
            <MenuSeparator key={index} className="my-1 h-px bg-slate-100 dark:bg-slate-800" />
          ) : (
            <MenuItem key={index} disabled={item.disabled}>
              <button
                type="button"
                onClick={item.onClick}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm",
                  "data-disabled:cursor-not-allowed data-disabled:opacity-50",
                  item.danger
                    ? "text-rose-600 data-focus:bg-rose-50 dark:text-rose-400 dark:data-focus:bg-rose-500/10"
                    : "text-slate-700 data-focus:bg-slate-100 dark:text-slate-300 dark:data-focus:bg-slate-800",
                )}
              >
                {item.icon && <span className="flex size-4 items-center justify-center opacity-80">{item.icon}</span>}
                <span className="flex-1">{item.label}</span>
                {item.hint && <span className="text-xs text-slate-400">{item.hint}</span>}
              </button>
            </MenuItem>
          ),
        )}
      </MenuItems>
    </Menu>
  );
}
