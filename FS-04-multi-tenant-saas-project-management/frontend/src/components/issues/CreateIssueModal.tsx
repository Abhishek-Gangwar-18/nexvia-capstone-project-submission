import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { MultiSelect, Select } from "@/components/ui/Select";
import { useCreateIssue, useIssues, useLabels, useMembers, useProjects, useSprints } from "@/hooks/queries";
import { getFieldErrors } from "@/lib/utils";
import { useUI } from "@/store/ui";
import type { IssueType, Priority } from "@/types";
import { LabelChip, useIssueDrawer } from "./IssueMeta";
import {
  epicOptions, labelOptions, memberOptions, priorityOptions, projectOptions, sprintOptions, statusOptions, typeOptions,
} from "./options";

interface FormState {
  projectId: number | null;
  issueType: IssueType;
  title: string;
  description: string;
  statusId: number | null;
  assignee: number | null;
  priority: Priority;
  sprintId: number | null;
  parentId: number | null;
  storyPoints: string;
  dueDate: string;
  labels: number[];
}

const blank: FormState = {
  projectId: null, issueType: "task", title: "", description: "", statusId: null, assignee: null, priority: 3,
  sprintId: null, parentId: null, storyPoints: "", dueDate: "", labels: [],
};

export function CreateIssueModal() {
  const { open, defaults } = useUI((s) => s.createIssue);
  const close = useUI((s) => s.closeCreateIssue);
  const projects = useProjects().data ?? [];
  const activeProjects = projects.filter((p) => !p.is_archived);
  const members = useMembers().data ?? [];
  const labels = useLabels().data ?? [];
  const create = useCreateIssue();
  const drawer = useIssueDrawer();
  const [form, setForm] = useState<FormState>(blank);
  const [another, setAnother] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const project = projects.find((p) => p.id === form.projectId);
  const sprints = useSprints(project?.key).data ?? [];
  const epics = useIssues({ project: project?.id, issue_type: "epic" }, { enabled: !!project }).data ?? [];

  // Reset with fresh defaults each time the modal opens.
  useEffect(() => {
    if (!open) return;
    const projectId = defaults.projectId ?? activeProjects[0]?.id ?? null;
    setForm({
      ...blank,
      projectId,
      statusId: defaults.statusId ?? null,
      sprintId: defaults.sprintId ?? null,
      parentId: defaults.parentId ?? null,
      issueType: defaults.issueType ?? "task",
    });
    setErrors({});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- only on open, not on every refetch

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const statuses = project?.statuses ?? [];
  const statusId = form.statusId ?? statuses[0]?.id ?? null;
  const showEpic = form.issueType !== "epic" && form.issueType !== "subtask";
  const selectedLabels = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!project) return;
    setErrors({});
    try {
      const issue = await create.mutateAsync({
        project: project.id,
        title: form.title,
        description: form.description,
        issue_type: form.issueType,
        priority: form.priority,
        status: statusId ?? undefined,
        assignee: form.assignee,
        sprint: form.sprintId,
        // Epic picker for story/task/bug; a sub-task keeps the parent it was opened from ("Add sub-task").
        parent: showEpic || form.issueType === "subtask" ? form.parentId : null,
        story_points: form.storyPoints === "" ? null : Number(form.storyPoints),
        due_date: form.dueDate || null,
        labels: form.labels,
      });
      toast.success(`${issue.key} created`, {
        description: issue.title,
        action: { label: "Open", onClick: () => drawer.open(issue.key) },
      });
      if (another) {
        setForm((f) => ({ ...f, title: "", description: "", storyPoints: "" }));
      } else {
        close();
      }
    } catch (error) {
      setErrors(getFieldErrors(error));
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title="Create issue"
      description="Capture a story, task or bug. You can refine everything later."
    >
      {activeProjects.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">Create a project first. Issues always live inside a project.</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Project">
              <Select
                value={form.projectId}
                onChange={(id) => setForm((f) => ({ ...f, projectId: id, statusId: null, sprintId: null, parentId: null }))}
                options={projectOptions(activeProjects)}
              />
            </Field>
            <Field label="Issue type">
              <Select value={form.issueType} onChange={(v) => set("issueType", v)} options={typeOptions()} />
            </Field>
          </div>
          <Field label="Summary" error={errors.title}>
            <Input
              autoFocus
              required
              maxLength={255}
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="What needs to be done?"
              invalid={!!errors.title}
            />
          </Field>
          <Field label="Description" hint="Markdown supported">
            <Textarea
              rows={4}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Add context, acceptance criteria, links…"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Status">
              <Select value={statusId} onChange={(v) => set("statusId", v)} options={statusOptions(statuses)} />
            </Field>
            <Field label="Assignee" error={errors.assignee}>
              <Select value={form.assignee} onChange={(v) => set("assignee", v)} options={memberOptions(members)} />
            </Field>
            <Field label="Priority">
              <Select value={form.priority} onChange={(v) => set("priority", v)} options={priorityOptions} />
            </Field>
            <Field label="Sprint" error={errors.sprint}>
              <Select value={form.sprintId} onChange={(v) => set("sprintId", v)} options={sprintOptions(sprints)} />
            </Field>
            <Field label="Story points" error={errors.story_points}>
              <Input
                type="number"
                min={0}
                max={100}
                value={form.storyPoints}
                onChange={(e) => set("storyPoints", e.target.value)}
                placeholder="—"
              />
            </Field>
            <Field label="Due date">
              <Input type="date" value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {showEpic && (
              <Field label="Epic" error={errors.parent}>
                <Select value={form.parentId} onChange={(v) => set("parentId", v)} options={epicOptions(epics)} />
              </Field>
            )}
            <Field label="Labels">
              <MultiSelect
                value={form.labels}
                onChange={(v) => set("labels", v)}
                options={labelOptions(labels)}
                buttonClassName="h-auto min-h-9 border border-slate-200 px-2.5 dark:border-slate-700"
                renderValue={(sel) => sel.map((o) => <LabelChip key={o.value} label={selectedLabels.get(o.value)!} />)}
              />
            </Field>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
              <input
                type="checkbox"
                checked={another}
                onChange={(e) => setAnother(e.target.checked)}
                className="size-4 rounded border-slate-300 accent-brand-600"
              />
              Create another
            </label>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button type="submit" variant="primary" loading={create.isPending} disabled={!form.title.trim()}>
                Create issue
              </Button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
