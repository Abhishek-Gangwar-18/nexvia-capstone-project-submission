import { DndContext, DragOverlay, MeasuringStrategy, useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CalendarDays, ChevronRight, CircleCheck, Ellipsis, GripVertical, Inbox, Pencil, Play, Plus, Trash, Zap,
} from "lucide-react";
import { memo, useCallback, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { BoardFilters, applyBoardFilters, emptyFilters, type BoardFilterState } from "@/components/board/BoardFilters";
import { LabelChips, PointsBadge, PriorityIcon, StatusBadge, TypeIcon, useIssueDrawer } from "@/components/issues/IssueMeta";
import { CompleteSprintModal, SprintFormModal, StartSprintModal } from "@/components/sprints/SprintModals";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { Avatar, Skeleton } from "@/components/ui/Misc";
import { ConfirmDialog } from "@/components/ui/Modal";
import {
  useCreateIssue, useDeleteSprint, useIssues, useLabels, useMembers, useMoveIssue, useSprints,
} from "@/hooks/queries";
import { useSortableContainers, type DropResult } from "@/hooks/useSortableContainers";
import { usePermissions, useProjectContext } from "@/hooks/useWorkspace";
import { cn, formatDate, pluralize, rankBetween } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import type { Issue, Label, Sprint, WorkflowStatus } from "@/types";

const BACKLOG = "backlog";
const sprintContainer = (id: number) => `sprint-${id}`;

interface RowProps {
  issue: Issue;
  labels: Map<number, Label>;
  status?: WorkflowStatus;
  onOpen?: (key: string) => void;
  overlay?: boolean;
  dragging?: boolean;
}

const IssueRow = memo(function IssueRow({ issue, labels, status, onOpen, overlay, dragging }: RowProps) {
  const done = issue.status_category === "done";
  return (
    <div
      onClick={() => onOpen?.(issue.key)}
      className={cn(
        "group flex cursor-pointer items-center gap-2.5 border-b border-slate-100 bg-white px-3 py-2 text-sm transition-colors last:border-b-0 hover:bg-slate-50",
        "dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800/60",
        overlay && "rounded-xl border border-brand-300 shadow-2xl ring-2 ring-brand-500/20",
        dragging && "opacity-40",
      )}
    >
      <GripVertical className="size-4 shrink-0 text-slate-300 opacity-0 transition group-hover:opacity-100 dark:text-slate-600" />
      <TypeIcon type={issue.issue_type} />
      <span className={cn("w-16 shrink-0 text-xs font-semibold text-slate-500", done && "line-through")}>{issue.key}</span>
      <span className={cn("min-w-0 flex-1 truncate", done && "text-slate-400")}>{issue.title}</span>
      <span className="hidden items-center gap-1.5 md:flex">
        {issue.parent_summary && (
          <span className="flex max-w-40 items-center gap-1 truncate rounded bg-violet-50 px-1.5 py-px text-[10px] font-semibold text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
            <Zap className="size-3 shrink-0" />
            <span className="truncate">{issue.parent_summary.title}</span>
          </span>
        )}
        <LabelChips ids={issue.labels} labels={labels} max={2} />
      </span>
      <StatusBadge category={issue.status_category} status={status} className="hidden sm:inline-flex" />
      <PointsBadge points={issue.story_points} />
      <PriorityIcon priority={issue.priority} />
      <Avatar user={issue.assignee_detail} size="sm" />
    </div>
  );
});

function SortableRow(props: Omit<RowProps, "overlay" | "dragging"> & { disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(props.issue.id),
    disabled: props.disabled,
  });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} {...attributes} {...listeners}>
      <IssueRow {...props} dragging={isDragging} />
    </div>
  );
}

function QuickCreate({ onCreate }: { onCreate: (title: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      await onCreate(title.trim());
      setTitle("");
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-sm text-slate-500 transition hover:bg-slate-50 hover:text-slate-800 dark:hover:bg-slate-800/50 dark:hover:text-slate-200"
      >
        <Plus className="size-4" /> Create issue
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="flex items-center gap-2 px-3 py-1.5">
      <TypeIcon type="task" />
      <input
        autoFocus
        value={title}
        disabled={saving}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        onBlur={() => !title.trim() && setOpen(false)}
        placeholder="What needs to be done? Press Enter to create"
        className="h-8 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
      />
    </form>
  );
}

function Container({
  id, header, issueIds, issuesById, labels, statuses, canEdit, onOpen, footer, emptyText,
}: {
  id: string;
  header: ReactNode;
  issueIds: string[];
  issuesById: Map<string, Issue>;
  labels: Map<number, Label>;
  statuses: WorkflowStatus[];
  canEdit: boolean;
  onOpen: (key: string) => void;
  footer?: ReactNode;
  emptyText: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className={cn("card overflow-hidden transition", isOver && "ring-2 ring-brand-400/50")}>
      <div className="flex items-center gap-2 bg-slate-50/80 px-3 py-2.5 dark:bg-slate-800/40">
        <IconButton label={collapsed ? "Expand" : "Collapse"} className="size-6" onClick={() => setCollapsed((v) => !v)}>
          <ChevronRight className={cn("size-4 transition", !collapsed && "rotate-90")} />
        </IconButton>
        {header}
      </div>
      {!collapsed && (
        <>
          <div ref={setNodeRef} className="min-h-12">
            <SortableContext items={issueIds} strategy={verticalListSortingStrategy}>
              {issueIds.map((issueId) => {
                const issue = issuesById.get(issueId);
                if (!issue) return null;
                return (
                  <SortableRow
                    key={issueId}
                    issue={issue}
                    labels={labels}
                    status={statuses.find((s) => s.id === issue.status)}
                    onOpen={onOpen}
                    disabled={!canEdit}
                  />
                );
              })}
            </SortableContext>
            {issueIds.length === 0 && (
              <div className="m-2 rounded-xl border-2 border-dashed border-slate-200 py-5 text-center text-sm text-slate-400 dark:border-slate-800">
                {emptyText}
              </div>
            )}
          </div>
          {footer && <div className="border-t border-slate-100 dark:border-slate-800">{footer}</div>}
        </>
      )}
    </section>
  );
}

function sprintStats(ids: string[], issuesById: Map<string, Issue>) {
  let points = 0;
  for (const id of ids) points += issuesById.get(id)?.story_points ?? 0;
  return `${pluralize(ids.length, "issue")} · ${points} pts`;
}

export default function BacklogPage() {
  const project = useProjectContext();
  const { canEdit: canEditWorkspace, isAdmin } = usePermissions();
  const canEdit = canEditWorkspace && !project.is_archived;
  const me = useAuth((s) => s.user);
  const { data: sprints = [], isLoading: sprintsLoading } = useSprints(project.key);
  const { data: issues = [], isLoading } = useIssues({ project: project.key, exclude_type: "epic" });
  const members = useMembers().data ?? [];
  const labelList = useLabels().data ?? [];
  const labels = useMemo(() => new Map(labelList.map((l) => [l.id, l])), [labelList]);
  const move = useMoveIssue();
  const createIssue = useCreateIssue();
  const deleteSprint = useDeleteSprint();
  const drawer = useIssueDrawer();
  const [filters, setFilters] = useState<BoardFilterState>(emptyFilters);
  const [sprintForm, setSprintForm] = useState<{ open: boolean; sprint: Sprint | null }>({ open: false, sprint: null });
  const [starting, setStarting] = useState<Sprint | null>(null);
  const [completing, setCompleting] = useState<Sprint | null>(null);
  const [deleting, setDeleting] = useState<Sprint | null>(null);

  const openSprints = useMemo(
    () => [...sprints].sort((a, b) => (a.state === "active" ? -1 : b.state === "active" ? 1 : a.id - b.id)),
    [sprints],
  );
  const plannedSprints = useMemo(() => sprints.filter((s) => s.state === "planned"), [sprints]);
  const hasActive = sprints.some((s) => s.state === "active");
  const openSprintIds = useMemo(() => new Set(sprints.map((s) => s.id)), [sprints]);

  const planIssues = useMemo(
    () => issues.filter((i) => i.sprint === null || openSprintIds.has(i.sprint)),
    [issues, openSprintIds],
  );
  const issuesById = useMemo(() => new Map(planIssues.map((i) => [String(i.id), i])), [planIssues]);
  const visible = useMemo(
    () => applyBoardFilters(planIssues, filters, me?.id).sort((a, b) => a.rank - b.rank || a.id - b.id),
    [planIssues, filters, me?.id],
  );
  const serverItems = useMemo(() => {
    const result: Record<string, string[]> = { [BACKLOG]: [] };
    for (const sprint of openSprints) result[sprintContainer(sprint.id)] = [];
    for (const issue of visible) {
      const key = issue.sprint === null ? BACKLOG : sprintContainer(issue.sprint);
      result[key]?.push(String(issue.id));
    }
    return result;
  }, [openSprints, visible]);

  const onDrop = useCallback(
    ({ id, to, prevId, nextId }: DropResult) => {
      const issue = issuesById.get(id);
      if (!issue) return;
      const sprint = to === BACKLOG ? null : Number(to.replace("sprint-", ""));
      const prev = prevId ? issuesById.get(prevId) : undefined;
      const next = nextId ? issuesById.get(nextId) : undefined;
      move.mutate({
        issue,
        sprint,
        prevId: prev?.id ?? null,
        nextId: next?.id ?? null,
        rank: rankBetween(prev?.rank, next?.rank),
      });
    },
    [issuesById, move],
  );
  const dnd = useSortableContainers(serverItems, onDrop);
  const activeIssue = dnd.activeId ? issuesById.get(dnd.activeId) : undefined;

  const quickCreate = (sprint: number | null) => (title: string) =>
    createIssue.mutateAsync({ project: project.id, title, issue_type: "task", sprint });

  if (isLoading || sprintsLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="animate-fade-in space-y-4 px-4 py-5 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BoardFilters value={filters} onChange={setFilters} members={members} placeholder="Search backlog" />
        {canEdit && (
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setSprintForm({ open: true, sprint: null })}>
            Create sprint
          </Button>
        )}
      </div>

      <DndContext
        sensors={dnd.sensors}
        collisionDetection={dnd.collisionDetection}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        {...dnd.handlers}
      >
        {openSprints.map((sprint) => {
          const containerId = sprintContainer(sprint.id);
          const ids = dnd.items[containerId] ?? [];
          return (
            <Container
              key={sprint.id}
              id={containerId}
              issueIds={ids}
              issuesById={issuesById}
              labels={labels}
              statuses={project.statuses}
              canEdit={canEdit}
              onOpen={drawer.open}
              emptyText="Drag issues here from the backlog to plan this sprint."
              footer={canEdit && <QuickCreate onCreate={quickCreate(sprint.id)} />}
              header={
                <>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">{sprint.name}</h3>
                      {sprint.state === "active" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-px text-[10px] font-bold tracking-wide text-emerald-700 uppercase dark:bg-emerald-500/15 dark:text-emerald-300">
                          <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> Active
                        </span>
                      )}
                      {(sprint.start_date || sprint.end_date) && (
                        <span className="flex items-center gap-1 text-xs text-slate-500">
                          <CalendarDays className="size-3.5" />
                          {formatDate(sprint.start_date, "MMM d")} – {formatDate(sprint.end_date, "MMM d")}
                        </span>
                      )}
                      <span className="text-xs text-slate-400">{sprintStats(ids, issuesById)}</span>
                    </div>
                    {sprint.goal && <p className="mt-0.5 truncate text-xs text-slate-500">{sprint.goal}</p>}
                  </div>
                  {canEdit && sprint.state === "planned" && (
                    <Button size="xs" variant="primary" icon={<Play className="size-3.5" />} disabled={hasActive || ids.length === 0}
                      title={hasActive ? "Complete the active sprint first" : ids.length === 0 ? "Add issues first" : undefined}
                      onClick={() => setStarting(sprint)}
                    >
                      Start sprint
                    </Button>
                  )}
                  {canEdit && sprint.state === "active" && (
                    <Button size="xs" icon={<CircleCheck className="size-3.5" />} onClick={() => setCompleting(sprint)}>
                      Complete sprint
                    </Button>
                  )}
                  {canEdit && (
                    <Dropdown
                      trigger={<IconButton label="Sprint actions" className="size-7"><Ellipsis className="size-4" /></IconButton>}
                      items={[
                        { label: "Edit sprint", icon: <Pencil className="size-4" />, onClick: () => setSprintForm({ open: true, sprint }) },
                        ...(sprint.state === "planned" && isAdmin
                          ? [{ label: "Delete sprint", icon: <Trash className="size-4" />, danger: true, onClick: () => setDeleting(sprint) }]
                          : []),
                      ]}
                    />
                  )}
                </>
              }
            />
          );
        })}

        <Container
          id={BACKLOG}
          issueIds={dnd.items[BACKLOG] ?? []}
          issuesById={issuesById}
          labels={labels}
          statuses={project.statuses}
          canEdit={canEdit}
          onOpen={drawer.open}
          emptyText="Your backlog is empty. Create an issue to get started."
          footer={canEdit && <QuickCreate onCreate={quickCreate(null)} />}
          header={
            <div className="flex flex-1 items-center gap-2">
              <Inbox className="size-4 text-slate-400" />
              <h3 className="text-sm font-semibold">Backlog</h3>
              <span className="text-xs text-slate-400">{sprintStats(dnd.items[BACKLOG] ?? [], issuesById)}</span>
            </div>
          }
        />

        <DragOverlay>
          {activeIssue ? (
            <IssueRow
              issue={activeIssue}
              labels={labels}
              status={project.statuses.find((s) => s.id === activeIssue.status)}
              overlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      <SprintFormModal
        open={sprintForm.open}
        sprint={sprintForm.sprint}
        project={project}
        onClose={() => setSprintForm({ open: false, sprint: null })}
      />
      <StartSprintModal sprint={starting} onClose={() => setStarting(null)} />
      <CompleteSprintModal sprint={completing} plannedSprints={plannedSprints} onClose={() => setCompleting(null)} />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="Its issues move back to the backlog. Nothing else is deleted."
        loading={deleteSprint.isPending}
        onConfirm={() =>
          deleting &&
          deleteSprint.mutate(deleting.id, {
            onSuccess: () => {
              toast.success("Sprint deleted");
              setDeleting(null);
            },
          })
        }
      />
    </div>
  );
}
