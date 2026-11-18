import type { CSSProperties } from "react";
import { CalendarDays } from "lucide-react";
import { useCallback } from "react";
import { useSearchParams } from "react-router";
import { CATEGORIES, ISSUE_TYPES, PRIORITIES } from "@/lib/constants";
import { cn, formatDate, isOverdue } from "@/lib/utils";
import type { IssueType, Label, Priority, StatusCategory, WorkflowStatus } from "@/types";

export function TypeIcon({ type, className }: { type: IssueType; className?: string }) {
  const meta = ISSUE_TYPES[type];
  const Icon = meta.icon;
  return (
    <span
      title={meta.label}
      className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded-[4px]", meta.bg, className)}
    >
      <Icon className="size-2.5 text-white" strokeWidth={3} />
    </span>
  );
}

export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const meta = PRIORITIES[priority];
  const Icon = meta.icon;
  return (
    <span title={`${meta.label} priority`} className={cn("inline-flex shrink-0", meta.color, className)}>
      <Icon className="size-4" strokeWidth={2.5} />
    </span>
  );
}

export function StatusBadge({
  status, category, className,
}: {
  status?: WorkflowStatus;
  category: StatusCategory;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase",
        CATEGORIES[category].badge,
        className,
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: status?.color ?? CATEGORIES[category].hex }} />
      <span className="truncate">{status?.name ?? CATEGORIES[category].label}</span>
    </span>
  );
}

export function StatusDot({ color }: { color: string }) {
  return <span className="size-2.5 shrink-0 rounded-full ring-2 ring-white dark:ring-slate-900" style={{ backgroundColor: color }} />;
}

export function LabelChip({ label, className }: { label: Label; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-px text-[10px] font-semibold",
        // Text from the label colour, mixed toward black (light) or white (dark) so it stays readable (WCAG AA).
        "text-[color-mix(in_srgb,var(--label)_55%,black)] dark:text-[color-mix(in_srgb,var(--label)_45%,white)]",
        className,
      )}
      style={{ backgroundColor: `${label.color}1f`, "--label": label.color } as CSSProperties}
    >
      {label.name}
    </span>
  );
}

export function LabelChips({ ids, labels, max = 3 }: { ids: number[]; labels: Map<number, Label>; max?: number }) {
  const items = ids.map((id) => labels.get(id)).filter((l): l is Label => !!l);
  if (!items.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {items.slice(0, max).map((label) => <LabelChip key={label.id} label={label} />)}
      {items.length > max && <span className="text-[10px] text-slate-400">+{items.length - max}</span>}
    </span>
  );
}

export function PointsBadge({ points }: { points: number | null }) {
  if (points === null || points === undefined) return null;
  return (
    <span
      title={`${points} story points`}
      className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-100 px-1.5 text-[10px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300"
    >
      {points}
    </span>
  );
}

export function DueChip({ date, done }: { date: string | null; done: boolean }) {
  if (!date) return null;
  const overdue = isOverdue(date, done);
  return (
    <span
      title={overdue ? "Overdue" : "Due date"}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold",
        overdue
          ? "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400"
          : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
      )}
    >
      <CalendarDays className="size-3" />
      {formatDate(date, "MMM d")}
    </span>
  );
}

/** Issues open in a drawer driven by `?issue=KEY`, so every issue view is linkable. */
export function useIssueDrawer() {
  const [params, setParams] = useSearchParams();
  const openKey = params.get("issue");
  const open = useCallback(
    (key: string) =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("issue", key);
        return next;
      }),
    [setParams],
  );
  const close = useCallback(
    () =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("issue");
        return next;
      }),
    [setParams],
  );
  return { openKey, open, close };
}
