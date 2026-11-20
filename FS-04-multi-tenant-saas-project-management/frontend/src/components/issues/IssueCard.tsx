import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Zap } from "lucide-react";
import { memo } from "react";
import { Avatar } from "@/components/ui/Misc";
import { cn } from "@/lib/utils";
import type { Issue, Label } from "@/types";
import { DueChip, LabelChips, PointsBadge, PriorityIcon, TypeIcon } from "./IssueMeta";

interface CardProps {
  issue: Issue;
  labels: Map<number, Label>;
  onOpen?: (key: string) => void;
  overlay?: boolean;
  dragging?: boolean;
}

export const IssueCardBody = memo(function IssueCardBody({ issue, labels, onOpen, overlay, dragging }: CardProps) {
  const done = issue.status_category === "done";
  return (
    <div
      onClick={() => onOpen?.(issue.key)}
      className={cn(
        "group relative cursor-pointer rounded-xl border bg-white p-3 text-left shadow-xs transition-[box-shadow,border-color,transform] duration-150",
        "border-slate-200/90 hover:border-brand-300 hover:shadow-md dark:border-slate-700/80 dark:bg-slate-800/80 dark:hover:border-brand-500/50",
        overlay && "rotate-[2deg] cursor-grabbing border-brand-400 shadow-2xl shadow-brand-900/20 ring-2 ring-brand-500/20",
        dragging && "opacity-40",
      )}
    >
      {issue.parent_summary && (
        <div className="mb-1.5 flex items-center gap-1 truncate text-[10px] font-semibold text-violet-600 dark:text-violet-400">
          <Zap className="size-3 shrink-0" />
          <span className="truncate">{issue.parent_summary.title}</span>
        </div>
      )}
      <p className={cn("text-sm leading-snug font-medium text-slate-800 dark:text-slate-100", done && "text-slate-500 line-through decoration-slate-300 dark:text-slate-400")}>
        {issue.title}
      </p>
      {(issue.labels.length > 0 || issue.due_date) && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <LabelChips ids={issue.labels} labels={labels} max={2} />
          <DueChip date={issue.due_date} done={done} />
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-1.5">
        <TypeIcon type={issue.issue_type} />
        <span className={cn("text-xs font-semibold text-slate-500 dark:text-slate-400", done && "line-through")}>{issue.key}</span>
        <span className="flex-1" />
        <PointsBadge points={issue.story_points} />
        <PriorityIcon priority={issue.priority} />
        <Avatar user={issue.assignee_detail} size="sm" />
      </div>
    </div>
  );
});

export function SortableIssueCard({
  issue, labels, onOpen, disabled,
}: Omit<CardProps, "overlay" | "dragging"> & { disabled?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(issue.id),
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className="touch-manipulation"
      {...attributes}
      {...listeners}
    >
      <IssueCardBody issue={issue} labels={labels} onOpen={onOpen} dragging={isDragging} />
    </div>
  );
}
