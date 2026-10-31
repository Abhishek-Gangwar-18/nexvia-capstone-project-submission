import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Gauge, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { SortableIssueCard } from "@/components/issues/IssueCard";
import { IconButton } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import type { Issue, Label, WorkflowStatus } from "@/types";

export function KanbanColumn({
  id, status, issueIds, issuesById, labels, wipLimit, canEdit, isAdmin, onOpen, onQuickAdd, onEditWip,
}: {
  id: string;
  status: WorkflowStatus;
  issueIds: string[];
  issuesById: Map<string, Issue>;
  labels: Map<number, Label>;
  wipLimit?: number;
  canEdit: boolean;
  isAdmin: boolean;
  onOpen: (key: string) => void;
  onQuickAdd: (statusId: number, title: string) => Promise<unknown>;
  onEditWip: (status: WorkflowStatus) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const count = issueIds.length;
  const overLimit = wipLimit !== undefined && count > wipLimit;
  const points = issueIds.reduce((sum, i) => sum + (issuesById.get(i)?.story_points ?? 0), 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      await onQuickAdd(status.id, title.trim());
      setTitle("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={cn(
        "flex max-h-full min-w-[260px] max-w-[380px] flex-1 flex-col rounded-2xl bg-slate-100/80 transition-colors dark:bg-slate-900/70",
        isOver && "bg-brand-50 ring-2 ring-brand-400/40 dark:bg-brand-500/5",
        overLimit && "bg-rose-50 ring-1 ring-rose-300 dark:bg-rose-500/5 dark:ring-rose-500/30",
      )}
    >
      <div className="group/header flex items-center gap-2 px-3 pt-3 pb-2">
        <span className="size-2.5 rounded-full" style={{ backgroundColor: status.color }} />
        <h3 className="truncate text-xs font-bold tracking-wider text-slate-600 uppercase dark:text-slate-300">{status.name}</h3>
        <span
          className={cn(
            "rounded-full px-1.5 py-px text-[11px] font-semibold",
            overLimit ? "bg-rose-500 text-white" : "bg-white text-slate-500 dark:bg-slate-800 dark:text-slate-400",
          )}
          title={wipLimit !== undefined ? `WIP limit ${wipLimit}` : undefined}
        >
          {count}
          {wipLimit !== undefined && ` / ${wipLimit}`}
        </span>
        <span className="flex-1" />
        {points > 0 && <span className="text-[11px] text-slate-400" title="Story points">{points} pts</span>}
        {isAdmin && (
          <IconButton
            label="Set WIP limit"
            className="size-6 opacity-0 transition group-hover/header:opacity-100"
            onClick={() => onEditWip(status)}
          >
            <Gauge className="size-3.5" />
          </IconButton>
        )}
      </div>

      <div ref={setNodeRef} className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        <SortableContext items={issueIds} strategy={verticalListSortingStrategy}>
          {issueIds.map((issueId) => {
            const issue = issuesById.get(issueId);
            if (!issue) return null;
            return <SortableIssueCard key={issueId} issue={issue} labels={labels} onOpen={onOpen} disabled={!canEdit} />;
          })}
        </SortableContext>
        {count === 0 && !adding && (
          <div className="flex flex-1 items-center justify-center rounded-xl border-2 border-dashed border-slate-200 py-8 text-xs text-slate-400 dark:border-slate-800">
            Drop issues here
          </div>
        )}
      </div>

      {canEdit && (
        <div className="px-2 pb-2">
          {adding ? (
            <form onSubmit={submit} className="rounded-xl border border-brand-300 bg-white p-2 shadow-sm dark:border-brand-500/40 dark:bg-slate-800">
              <textarea
                autoFocus
                rows={2}
                value={title}
                disabled={saving}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit(e);
                  }
                  if (e.key === "Escape") setAdding(false);
                }}
                onBlur={() => !title.trim() && setAdding(false)}
                placeholder="What needs to be done? (Enter to save)"
                className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-slate-400"
              />
            </form>
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-slate-500 transition hover:bg-white hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <Plus className="size-4" /> Create issue
            </button>
          )}
        </div>
      )}
    </div>
  );
}
