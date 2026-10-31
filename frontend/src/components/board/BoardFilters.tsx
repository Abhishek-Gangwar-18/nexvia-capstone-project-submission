import { Search, X } from "lucide-react";
import { Avatar } from "@/components/ui/Misc";
import { Input } from "@/components/ui/Input";
import { TypeIcon } from "@/components/issues/IssueMeta";
import { ISSUE_TYPES } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { Issue, IssueType, Member } from "@/types";

export interface BoardFilterState {
  search: string;
  assignees: number[];
  types: IssueType[];
  onlyMine: boolean;
}

export const emptyFilters: BoardFilterState = { search: "", assignees: [], types: [], onlyMine: false };

export function applyBoardFilters(issues: Issue[], filters: BoardFilterState, meId?: number) {
  const q = filters.search.trim().toLowerCase();
  return issues.filter((issue) => {
    if (q && !`${issue.key} ${issue.title}`.toLowerCase().includes(q)) return false;
    if (filters.onlyMine && issue.assignee !== meId) return false;
    if (filters.assignees.length && !filters.assignees.includes(issue.assignee ?? -1)) return false;
    if (filters.types.length && !filters.types.includes(issue.issue_type)) return false;
    return true;
  });
}

export function BoardFilters({
  value, onChange, members, types = ["story", "task", "bug", "subtask"], placeholder = "Search this board",
}: {
  value: BoardFilterState;
  onChange: (value: BoardFilterState) => void;
  members: Member[];
  types?: IssueType[];
  placeholder?: string;
}) {
  const active = value.search || value.assignees.length || value.types.length || value.onlyMine;
  const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative w-56">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
        <Input
          value={value.search}
          onChange={(e) => onChange({ ...value, search: e.target.value })}
          placeholder={placeholder}
          className="h-8 pl-9"
        />
      </div>
      <div className="flex -space-x-1.5">
        {members.slice(0, 8).map((m) => {
          const selected = value.assignees.includes(m.user.id);
          return (
            <button
              key={m.id}
              onClick={() => onChange({ ...value, assignees: toggle(value.assignees, m.user.id) })}
              className={cn(
                "cursor-pointer rounded-full transition hover:z-10 hover:-translate-y-0.5",
                selected && "z-10 ring-2 ring-brand-500 ring-offset-2 dark:ring-offset-slate-950",
              )}
            >
              <Avatar user={m.user} size="md" ring />
            </button>
          );
        })}
      </div>
      <button
        onClick={() => onChange({ ...value, onlyMine: !value.onlyMine })}
        className={cn(
          "h-8 cursor-pointer rounded-lg px-3 text-sm font-medium transition",
          value.onlyMine
            ? "bg-brand-600 text-white"
            : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800",
        )}
      >
        Only my issues
      </button>
      <div className="flex items-center gap-1">
        {types.map((type) => (
          <button
            key={type}
            title={ISSUE_TYPES[type].label}
            onClick={() => onChange({ ...value, types: toggle(value.types, type) })}
            className={cn(
              "flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition",
              value.types.includes(type)
                ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800",
            )}
          >
            <TypeIcon type={type} />
            <span className="hidden md:inline">{ISSUE_TYPES[type].label}</span>
          </button>
        ))}
      </div>
      {active ? (
        <button
          onClick={() => onChange(emptyFilters)}
          className="flex h-8 cursor-pointer items-center gap-1 rounded-lg px-2 text-sm text-slate-500 hover:text-slate-900 dark:hover:text-white"
        >
          <X className="size-3.5" /> Clear
        </button>
      ) : null}
    </div>
  );
}
