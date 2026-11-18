import { Check, Copy, Ellipsis, Link as LinkIcon, Pencil, Plus, Trash, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import { toast } from "sonner";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { Dropdown } from "@/components/ui/Dropdown";
import { Avatar, EmptyState, Skeleton } from "@/components/ui/Misc";
import { ConfirmDialog, Drawer } from "@/components/ui/Modal";
import { MultiSelect, Select } from "@/components/ui/Select";
import {
  useDeleteIssue, useIssue, useIssues, useLabels, useMembers, useProjects, useSprints, useUpdateIssue,
  type IssueBody,
} from "@/hooks/queries";
import { usePermissions } from "@/hooks/useWorkspace";
import { cn, formatDate, timeAgo } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import { useUI } from "@/store/ui";
import type { IssueDetail, IssueType, Priority } from "@/types";
import { LabelChip, PriorityIcon, StatusBadge, TypeIcon, useIssueDrawer } from "./IssueMeta";
import { IssueCollaboration } from "./IssueCollaboration";
import {
  epicOptions, labelOptions, memberOptions, priorityOptions, sprintOptions, statusOptions, typeOptions,
} from "./options";

export function IssueDrawer() {
  const { openKey, close } = useIssueDrawer();
  // Keep the last key while the panel animates out.
  const [key, setKey] = useState(openKey);
  useEffect(() => {
    if (openKey) setKey(openKey);
  }, [openKey]);

  return (
    <Drawer open={!!openKey} onClose={close} label="Issue details">
      {key && <IssuePanel issueKey={key} onClose={close} />}
    </Drawer>
  );
}

function IssuePanel({ issueKey, onClose }: { issueKey: string; onClose: () => void }) {
  const { data: issue, isLoading, isError } = useIssue(issueKey);

  if (isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (isError || !issue) {
    return (
      <EmptyState
        className="h-full"
        icon={<X className="size-5" />}
        title="Issue not found"
        description="It may have been deleted, or it belongs to a workspace you can't access."
        action={<Button onClick={onClose}>Close</Button>}
      />
    );
  }
  return <IssueEditor issue={issue} onClose={onClose} />;
}

function IssueEditor({ issue, onClose }: { issue: IssueDetail; onClose: () => void }) {
  const { canEdit: canEditWorkspace, isAdmin } = usePermissions();
  const update = useUpdateIssue(issue.key);
  const remove = useDeleteIssue();
  const projects = useProjects().data ?? [];
  const members = useMembers().data ?? [];
  const labels = useLabels().data ?? [];
  const project = projects.find((p) => p.id === issue.project);
  const canEdit = canEditWorkspace && !project?.is_archived; // archived projects are read-only
  const sprints = useSprints(project?.key).data ?? [];
  const epics = useIssues({ project: issue.project, issue_type: "epic" }).data ?? [];
  const openCreate = useUI((s) => s.openCreateIssue);
  const { open: openIssue } = useIssueDrawer();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const labelMap = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  const statuses = project?.statuses ?? [];
  const status = statuses.find((s) => s.id === issue.status);
  const save = (body: IssueBody) => update.mutate(body);
  const me = useAuth((s) => s.user);
  const canDelete = canEdit && (isAdmin || issue.reporter_detail?.id === me?.id);

  const sprintChoices = sprints.some((s) => s.id === issue.sprint) || issue.sprint === null
    ? sprintOptions(sprints)
    : [...sprintOptions(sprints), { value: issue.sprint, label: "Closed sprint" }];

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    toast.success("Link copied");
  };

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
        {issue.parent_summary && (
          <>
            <button
              onClick={() => openIssue(issue.parent_summary!.key)}
              className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-brand-600"
            >
              <TypeIcon type={issue.parent_summary.issue_type} />
              {issue.parent_summary.key}
            </button>
            <span className="text-slate-300">/</span>
          </>
        )}
        <TypeIcon type={issue.issue_type} />
        <span className="text-sm font-semibold text-slate-600 dark:text-slate-300">{issue.key}</span>
        <div className="flex-1" />
        <IconButton label="Copy link" onClick={copyLink}>
          <LinkIcon className="size-4" />
        </IconButton>
        {canEdit && (
          <Dropdown
            trigger={
              <IconButton label="More actions">
                <Ellipsis className="size-4" />
              </IconButton>
            }
            items={[
              { label: "Copy issue key", icon: <Copy className="size-4" />, onClick: () => { navigator.clipboard.writeText(issue.key); toast.success("Key copied"); } },
              ...(issue.issue_type !== "subtask"
                ? [{
                    label: issue.issue_type === "epic" ? "Add issue to epic" : "Add sub-task",
                    icon: <Plus className="size-4" />,
                    onClick: () => openCreate({
                      projectId: issue.project,
                      parentId: issue.id,
                      issueType: (issue.issue_type === "epic" ? "story" : "subtask") as IssueType,
                      sprintId: issue.issue_type === "epic" ? null : issue.sprint,
                    }),
                  }]
                : []),
              { separator: true, label: "" },
              { label: "Delete issue", icon: <Trash className="size-4" />, danger: true, disabled: !canDelete, onClick: () => setConfirmDelete(true) },
            ]}
          />
        )}
        <IconButton label="Close" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {/* main column */}
        <div className="min-w-0 flex-1 space-y-6 px-6 py-5 lg:overflow-y-auto">
          <EditableTitle value={issue.title} disabled={!canEdit} onSave={(title) => save({ title })} />
          <DescriptionEditor value={issue.description} disabled={!canEdit} onSave={(description) => save({ description })} />

          {(issue.issue_type === "epic" || issue.children.length > 0) && (
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  {issue.issue_type === "epic" ? "Issues in this epic" : "Sub-tasks"}
                  <span className="ml-1.5 text-slate-400">{issue.children.length}</span>
                </h3>
                {canEdit && (
                  <Button
                    size="xs"
                    variant="ghost"
                    icon={<Plus className="size-3.5" />}
                    onClick={() => openCreate({
                      projectId: issue.project,
                      parentId: issue.id,
                      issueType: issue.issue_type === "epic" ? "story" : "subtask",
                    })}
                  >
                    Add
                  </Button>
                )}
              </div>
              {issue.children.length > 0 && (
                <>
                  <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-all"
                      style={{ width: `${(issue.children.filter((c) => c.status_category === "done").length / issue.children.length) * 100}%` }}
                    />
                  </div>
                  <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                    {issue.children.map((child) => (
                      <li key={child.id}>
                        <button
                          onClick={() => openIssue(child.key)}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50"
                        >
                          <TypeIcon type={child.issue_type} />
                          <span className="w-16 shrink-0 text-xs font-semibold text-slate-500">{child.key}</span>
                          <span className={cn("flex-1 truncate", child.status_category === "done" && "text-slate-400 line-through")}>{child.title}</span>
                          <PriorityIcon priority={child.priority} />
                          <StatusBadge category={child.status_category} status={statuses.find((s) => s.id === child.status)} />
                          <Avatar user={child.assignee_detail} size="xs" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

          <IssueCollaboration key={issue.key} issueKey={issue.key} members={members.map((membership) => membership.user)} />
        </div>

        {/* details sidebar */}
        <aside className="w-full shrink-0 border-t border-slate-100 bg-slate-50/50 px-5 py-5 lg:w-80 lg:overflow-y-auto lg:border-t-0 lg:border-l dark:border-slate-800 dark:bg-slate-900/50">
          <div className="mb-5">
            <Select
              value={issue.status}
              onChange={(value) => save({ status: value })}
              options={statusOptions(statuses)}
              disabled={!canEdit}
              className="w-48"
              buttonClassName={cn(
                "font-semibold",
                status?.category === "done" && "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300",
                status?.category === "in_progress" && "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-300",
              )}
            />
          </div>
          <dl className="space-y-1">
            <DetailRow label="Assignee">
              <Select
                variant="ghost"
                size="sm"
                value={issue.assignee}
                onChange={(assignee) => save({ assignee })}
                options={memberOptions(members, "Unassigned", issue.assignee)}
                disabled={!canEdit}
              />
            </DetailRow>
            <DetailRow label="Reporter">
              <div className="flex h-8 items-center gap-2 px-2 text-sm">
                <Avatar user={issue.reporter_detail} size="xs" />
                <span className="truncate">{issue.reporter_detail?.display_name ?? "—"}</span>
              </div>
            </DetailRow>
            <DetailRow label="Priority">
              <Select
                variant="ghost"
                size="sm"
                value={issue.priority}
                onChange={(priority: Priority) => save({ priority })}
                options={priorityOptions}
                disabled={!canEdit}
              />
            </DetailRow>
            <DetailRow label="Type">
              <Select
                variant="ghost"
                size="sm"
                value={issue.issue_type}
                onChange={(issue_type: IssueType) => save({ issue_type })}
                options={typeOptions()}
                disabled={!canEdit}
              />
            </DetailRow>
            <DetailRow label="Sprint">
              <Select
                variant="ghost"
                size="sm"
                value={issue.sprint}
                onChange={(sprint) => save({ sprint })}
                options={sprintChoices}
                disabled={!canEdit}
              />
            </DetailRow>
            {issue.issue_type !== "epic" && issue.issue_type !== "subtask" && (
              <DetailRow label="Epic">
                <Select
                  variant="ghost"
                  size="sm"
                  value={issue.parent}
                  onChange={(parent) => save({ parent })}
                  options={epicOptions(epics)}
                  disabled={!canEdit}
                />
              </DetailRow>
            )}
            <DetailRow label="Story points">
              <InlineNumber value={issue.story_points} disabled={!canEdit} onSave={(story_points) => save({ story_points })} />
            </DetailRow>
            <DetailRow label="Due date">
              <input
                type="date"
                disabled={!canEdit}
                value={issue.due_date ?? ""}
                onChange={(e) => save({ due_date: e.target.value || null })}
                className="h-8 w-full rounded-lg bg-transparent px-2 text-sm hover:bg-slate-100 focus:bg-white focus:ring-2 focus:ring-brand-500/20 focus:outline-none disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:focus:bg-slate-900"
              />
            </DetailRow>
            <DetailRow label="Labels">
              <MultiSelect
                value={issue.labels}
                onChange={(ids) => save({ labels: ids })}
                options={labelOptions(labels)}
                disabled={!canEdit}
                renderValue={(selected) =>
                  selected.map((o) => {
                    const label = labelMap.get(o.value);
                    return label ? <LabelChip key={label.id} label={label} /> : null;
                  })
                }
              />
            </DetailRow>
          </dl>
          <div className="mt-6 space-y-1 border-t border-slate-200 pt-4 text-xs text-slate-500 dark:border-slate-800">
            <p>Created {formatDate(issue.created_at, "MMM d, yyyy 'at' HH:mm")}</p>
            <p>Updated {timeAgo(issue.updated_at)}</p>
            {issue.resolved_at && <p className="text-emerald-600 dark:text-emerald-400">Resolved {timeAgo(issue.resolved_at)}</p>}
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${issue.key}?`}
        description="This permanently removes the issue. Sub-issues stay but lose their parent."
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(issue.key, {
            onSuccess: () => {
              toast.success(`${issue.key} deleted`);
              setConfirmDelete(false);
              onClose();
            },
          })
        }
      />
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] items-center gap-2">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function EditableTitle({ value, onSave, disabled }: { value: string; onSave: (v: string) => void; disabled: boolean }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) onSave(next);
    else setDraft(value);
  };

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        maxLength={255}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        className="h-auto py-1.5 text-xl font-semibold"
      />
    );
  }
  return (
    <h2
      onClick={() => !disabled && setEditing(true)}
      className={cn(
        "-mx-2 rounded-lg px-2 py-1 text-xl leading-snug font-semibold text-slate-900 dark:text-slate-50",
        !disabled && "cursor-text hover:bg-slate-100 dark:hover:bg-slate-800",
      )}
    >
      {value}
    </h2>
  );
}

function DescriptionEditor({ value, onSave, disabled }: { value: string; onSave: (v: string) => void; disabled: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Description</h3>
        {!disabled && !editing && (
          <Button size="xs" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          <Textarea autoFocus rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} className="font-mono text-[13px]" />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              icon={<Check className="size-4" />}
              onClick={() => {
                onSave(draft);
                setEditing(false);
              }}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(value);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : value ? (
        <div
          className={cn("prose-issue -mx-2 rounded-lg px-2 py-1", !disabled && "cursor-text hover:bg-slate-50 dark:hover:bg-slate-800/50")}
          onDoubleClick={() => !disabled && setEditing(true)}
        >
          <Markdown>{value}</Markdown>
        </div>
      ) : (
        <button
          disabled={disabled}
          onClick={() => setEditing(true)}
          className="w-full rounded-lg border border-dashed border-slate-200 px-3 py-6 text-sm text-slate-400 hover:border-brand-300 hover:text-brand-600 disabled:pointer-events-none dark:border-slate-700"
        >
          {disabled ? "No description" : "Add a description…"}
        </button>
      )}
    </section>
  );
}

function InlineNumber({ value, onSave, disabled }: { value: number | null; onSave: (v: number | null) => void; disabled: boolean }) {
  const [draft, setDraft] = useState(value?.toString() ?? "");
  useEffect(() => setDraft(value?.toString() ?? ""), [value]);
  const commit = () => {
    const next = draft === "" ? null : Math.max(0, Math.min(100, Number(draft)));
    if (next !== value && (next === null || !Number.isNaN(next))) onSave(next);
  };
  return (
    <input
      type="number"
      min={0}
      max={100}
      disabled={disabled}
      value={draft}
      placeholder="—"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="h-8 w-full rounded-lg bg-transparent px-2 text-sm hover:bg-slate-100 focus:bg-white focus:ring-2 focus:ring-brand-500/20 focus:outline-none disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:focus:bg-slate-900"
    />
  );
}
