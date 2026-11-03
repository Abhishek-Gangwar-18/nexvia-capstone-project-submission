import { DndContext, DragOverlay, MeasuringStrategy, defaultDropAnimationSideEffects } from "@dnd-kit/core";
import { differenceInCalendarDays, parseISO } from "date-fns";
import { CalendarDays, CircleCheck, ListTodo, Rocket } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { BoardFilters, applyBoardFilters, emptyFilters, type BoardFilterState } from "@/components/board/BoardFilters";
import { KanbanColumn } from "@/components/board/KanbanColumn";
import { IssueCardBody } from "@/components/issues/IssueCard";
import { useIssueDrawer } from "@/components/issues/IssueMeta";
import { CompleteSprintModal } from "@/components/sprints/SprintModals";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { EmptyState, ProgressBar, Skeleton } from "@/components/ui/Misc";
import { Modal } from "@/components/ui/Modal";
import {
  useCreateIssue, useIssues, useLabels, useMembers, useMoveIssue, useSprints, useUpdateBoard, useWorkflow,
} from "@/hooks/queries";
import { useSortableContainers, type DropResult } from "@/hooks/useSortableContainers";
import { usePermissions, useProjectContext, useWorkspace } from "@/hooks/useWorkspace";
import { formatDate, percent, rankBetween } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import type { WorkflowStatus } from "@/types";

const columnId = (statusId: number) => `col-${statusId}`;

export default function BoardPage() {
  const project = useProjectContext();
  const workspace = useWorkspace();
  const { canEdit: canEditWorkspace, isAdmin } = usePermissions();
  const canEdit = canEditWorkspace && !project.is_archived;
  const me = useAuth((s) => s.user);
  const isScrum = project.board?.board_type === "scrum";
  const sprints = useSprints(project.key).data ?? [];
  const activeSprint = sprints.find((s) => s.state === "active") ?? null;
  const plannedSprints = useMemo(() => sprints.filter((s) => s.state === "planned"), [sprints]);
  const needsSprint = isScrum && !project.active_sprint;

  const { data: issues = [], isLoading } = useIssues(
    { project: project.key, exclude_type: "epic", ...(isScrum ? { sprint: "active" } : {}) },
    { enabled: !needsSprint },
  );
  const members = useMembers().data ?? [];
  const labelList = useLabels().data ?? [];
  const labels = useMemo(() => new Map(labelList.map((l) => [l.id, l])), [labelList]);
  const move = useMoveIssue();
  const createIssue = useCreateIssue();
  const updateBoard = useUpdateBoard();
  const drawer = useIssueDrawer();
  const [filters, setFilters] = useState<BoardFilterState>(emptyFilters);
  const [completing, setCompleting] = useState(false);
  const [wipStatus, setWipStatus] = useState<WorkflowStatus | null>(null);
  const [wipValue, setWipValue] = useState("");

  const statuses = project.statuses;
  const workflow = useWorkflow(project.key, project.enforce_transitions).data;
  // "from:to" status id pairs the workflow allows; null means every move is allowed.
  const allowedMoves = useMemo(() => {
    if (!project.enforce_transitions || !workflow) return null;
    return new Set(workflow.transitions.map((t) => `${workflow.statuses[t.from].id}:${workflow.statuses[t.to].id}`));
  }, [project.enforce_transitions, workflow]);
  const canMove = useCallback(
    (fromId: number, toId: number) => fromId === toId || !allowedMoves || allowedMoves.has(`${fromId}:${toId}`),
    [allowedMoves],
  );
  const issuesById = useMemo(() => new Map(issues.map((i) => [String(i.id), i])), [issues]);
  const visible = useMemo(
    () => applyBoardFilters(issues, filters, me?.id).sort((a, b) => a.rank - b.rank || a.id - b.id),
    [issues, filters, me?.id],
  );
  const serverItems = useMemo(
    () =>
      Object.fromEntries(
        statuses.map((s) => [columnId(s.id), visible.filter((i) => i.status === s.id).map((i) => String(i.id))]),
      ),
    [statuses, visible],
  );

  const onDrop = useCallback(
    ({ id, to, prevId, nextId }: DropResult) => {
      const issue = issuesById.get(id);
      const status = statuses.find((s) => columnId(s.id) === to);
      if (!issue || !status) return;
      if (!canMove(issue.status, status.id)) {
        toast.error(`This workflow doesn't allow moving ${issue.key} to ${status.name}.`);
        return;
      }
      const prev = prevId ? issuesById.get(prevId) : undefined;
      const next = nextId ? issuesById.get(nextId) : undefined;
      const finishing = status.id !== issue.status && status.category === "done";
      move.mutate(
        {
          issue,
          status: status.id,
          statusCategory: status.category,
          prevId: prev?.id ?? null,
          nextId: next?.id ?? null,
          rank: rankBetween(prev?.rank, next?.rank),
        },
        { onSuccess: () => finishing && toast.success(`${issue.key} done ✓`) },
      );
    },
    [issuesById, statuses, move, canMove],
  );

  const dnd = useSortableContainers(serverItems, onDrop);
  const activeIssue = dnd.activeId ? issuesById.get(dnd.activeId) : undefined;

  const quickAdd = (statusId: number, title: string) =>
    createIssue.mutateAsync({
      project: project.id,
      title,
      status: statusId,
      issue_type: "task",
      sprint: isScrum ? activeSprint?.id ?? null : null,
    });

  const saveWip = () => {
    if (!project.board || !wipStatus) return;
    const limits = { ...project.board.wip_limits };
    const value = parseInt(wipValue, 10);
    if (Number.isNaN(value) || value <= 0) delete limits[String(wipStatus.id)];
    else limits[String(wipStatus.id)] = value;
    updateBoard.mutate(
      { id: project.board.id, wip_limits: limits },
      {
        onSuccess: () => {
          toast.success("WIP limit saved");
          setWipStatus(null);
        },
      },
    );
  };

  if (needsSprint) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          icon={<Rocket className="size-6" />}
          title="No active sprint"
          description="Plan a sprint in the backlog and start it to see its issues on the board."
          action={
            <Link to={`/w/${workspace.slug}/projects/${project.key}/backlog`}>
              <Button variant="primary" icon={<ListTodo className="size-4" />}>Go to backlog</Button>
            </Link>
          }
        />
      </div>
    );
  }

  const daysLeft = activeSprint?.end_date ? differenceInCalendarDays(parseISO(activeSprint.end_date), new Date()) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-4 px-4 pt-5 pb-4 sm:px-8">
        {isScrum && activeSprint && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="min-w-0">
              <h2 className="font-semibold">{activeSprint.name}</h2>
              {activeSprint.goal && <p className="max-w-xl truncate text-sm text-slate-500">{activeSprint.goal}</p>}
            </div>
            <div className="flex items-center gap-1.5 text-sm text-slate-500">
              <CalendarDays className="size-4" />
              {formatDate(activeSprint.start_date, "MMM d")} – {formatDate(activeSprint.end_date, "MMM d")}
              {daysLeft !== null && (
                <span className={daysLeft < 0 ? "font-semibold text-rose-600" : "font-medium text-slate-700 dark:text-slate-300"}>
                  · {daysLeft < 0 ? `${-daysLeft}d overdue` : `${daysLeft}d left`}
                </span>
              )}
            </div>
            <div className="w-48">
              <div className="mb-1 flex justify-between text-[11px] text-slate-500">
                <span>{activeSprint.done_count}/{activeSprint.issue_count} done</span>
                <span>{activeSprint.done_points}/{activeSprint.total_points} pts</span>
              </div>
              <ProgressBar value={percent(activeSprint.done_points, activeSprint.total_points)} />
            </div>
            <div className="flex-1" />
            {canEdit && (
              <Button size="sm" icon={<CircleCheck className="size-4" />} onClick={() => setCompleting(true)}>
                Complete sprint
              </Button>
            )}
          </div>
        )}
        <BoardFilters value={filters} onChange={setFilters} members={members} />
      </div>

      {isLoading ? (
        <div className="flex gap-4 px-4 sm:px-8">
          {statuses.map((s) => <Skeleton key={s.id} className="h-96 min-w-[260px] flex-1" />)}
        </div>
      ) : (
        <DndContext
          sensors={dnd.sensors}
          collisionDetection={dnd.collisionDetection}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          {...dnd.handlers}
        >
          <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto px-4 pb-6 sm:px-8">
            {statuses.map((status) => (
              <KanbanColumn
                key={status.id}
                id={columnId(status.id)}
                status={status}
                issueIds={dnd.items[columnId(status.id)] ?? []}
                issuesById={issuesById}
                labels={labels}
                wipLimit={project.board?.wip_limits[String(status.id)]}
                canEdit={canEdit}
                isAdmin={isAdmin}
                blocked={!!activeIssue && !canMove(activeIssue.status, status.id)}
                onOpen={drawer.open}
                onQuickAdd={quickAdd}
                onEditWip={(s) => {
                  setWipStatus(s);
                  setWipValue(String(project.board?.wip_limits[String(s.id)] ?? ""));
                }}
              />
            ))}
          </div>
          <DragOverlay
            dropAnimation={{ sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.4" } } }) }}
          >
            {activeIssue ? <IssueCardBody issue={activeIssue} labels={labels} overlay /> : null}
          </DragOverlay>
        </DndContext>
      )}

      <CompleteSprintModal
        sprint={completing ? activeSprint : null}
        plannedSprints={plannedSprints}
        onClose={() => setCompleting(false)}
      />
      <Modal
        open={!!wipStatus}
        onClose={() => setWipStatus(null)}
        size="sm"
        title={`WIP limit · ${wipStatus?.name ?? ""}`}
        description="Highlight the column when it holds more issues than this. Leave empty for no limit."
        footer={
          <>
            <Button variant="ghost" onClick={() => setWipStatus(null)}>Cancel</Button>
            <Button variant="primary" loading={updateBoard.isPending} onClick={saveWip}>Save</Button>
          </>
        }
      >
        <Field label="Maximum issues">
          <Input
            type="number"
            min={0}
            autoFocus
            value={wipValue}
            onChange={(e) => setWipValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveWip()}
            placeholder="No limit"
          />
        </Field>
      </Modal>
    </div>
  );
}
