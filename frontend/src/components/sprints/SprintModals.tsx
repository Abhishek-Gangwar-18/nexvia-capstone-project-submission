import { addDays, format } from "date-fns";
import { CircleCheck, Play, Rocket } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { ProgressBar } from "@/components/ui/Misc";
import { Select } from "@/components/ui/Select";
import { useCompleteSprint, useSaveSprint, useStartSprint } from "@/hooks/queries";
import { percent, pluralize } from "@/lib/utils";
import type { Project, Sprint } from "@/types";

const iso = (date: Date) => format(date, "yyyy-MM-dd");

export function SprintFormModal({
  open, onClose, project, sprint,
}: {
  open: boolean;
  onClose: () => void;
  project: Project;
  sprint?: Sprint | null;
}) {
  const save = useSaveSprint();
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(sprint?.name ?? "");
    setGoal(sprint?.goal ?? "");
    setStart(sprint?.start_date ?? "");
    setEnd(sprint?.end_date ?? "");
  }, [open, sprint]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      { id: sprint?.id, project: project.id, name, goal, start_date: start || null, end_date: end || null },
      {
        onSuccess: (saved) => {
          toast.success(sprint ? "Sprint updated" : `${saved.name} created`);
          onClose();
        },
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title={sprint ? "Edit sprint" : "Create sprint"} description={project.name}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" hint={sprint ? undefined : "Leave empty to auto-number it."}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${project.key} Sprint …`} autoFocus />
        </Field>
        <Field label="Sprint goal">
          <Textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What should this sprint achieve?" />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Start date">
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="End date">
            <Input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{sprint ? "Save" : "Create sprint"}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function StartSprintModal({ sprint, onClose }: { sprint: Sprint | null; onClose: () => void }) {
  const start = useStartSprint();
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [goal, setGoal] = useState("");

  useEffect(() => {
    if (!sprint) return;
    const today = new Date();
    setStartDate(sprint.start_date ?? iso(today));
    setEndDate(sprint.end_date ?? iso(addDays(today, 14)));
    setGoal(sprint.goal);
  }, [sprint]);

  return (
    <Modal
      open={!!sprint}
      onClose={onClose}
      title={`Start ${sprint?.name ?? "sprint"}`}
      icon={<span className="flex size-9 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/10"><Rocket className="size-5" /></span>}
      description={sprint ? `${pluralize(sprint.issue_count, "issue")} · ${sprint.total_points} points planned` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={<Play className="size-4" />}
            loading={start.isPending}
            onClick={() =>
              sprint &&
              start.mutate(
                { id: sprint.id, start_date: startDate, end_date: endDate, goal },
                {
                  onSuccess: () => {
                    toast.success(`${sprint.name} started. Good luck!`);
                    onClose();
                  },
                },
              )
            }
          >
            Start sprint
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Start date">
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="End date">
            <Input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Sprint goal">
          <Textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What should this sprint achieve?" />
        </Field>
      </div>
    </Modal>
  );
}

export function CompleteSprintModal({
  sprint, plannedSprints, onClose,
}: {
  sprint: Sprint | null;
  plannedSprints: Sprint[];
  onClose: () => void;
}) {
  const complete = useCompleteSprint();
  const [target, setTarget] = useState<number | null>(null);

  const defaultTarget = plannedSprints[0]?.id ?? null;
  useEffect(() => {
    setTarget(defaultTarget);
  }, [sprint?.id, defaultTarget]);

  if (!sprint) return <Modal open={false} onClose={onClose} title="" />;
  const open = sprint.issue_count - sprint.done_count;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Complete ${sprint.name}`}
      icon={<span className="flex size-9 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10"><CircleCheck className="size-5" /></span>}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={complete.isPending}
            onClick={() =>
              complete.mutate(
                { id: sprint.id, moveTo: open > 0 ? target : null },
                {
                  onSuccess: () => {
                    toast.success(`${sprint.name} completed 🎉`);
                    onClose();
                  },
                },
              )
            }
          >
            Complete sprint
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-emerald-50 p-4 dark:bg-emerald-500/10">
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">{sprint.done_count}</p>
            <p className="text-xs font-medium text-emerald-700/80 dark:text-emerald-300/80">completed issues</p>
          </div>
          <div className="rounded-xl bg-amber-50 p-4 dark:bg-amber-500/10">
            <p className="text-2xl font-bold text-amber-700 dark:text-amber-300">{open}</p>
            <p className="text-xs font-medium text-amber-700/80 dark:text-amber-300/80">open issues</p>
          </div>
        </div>
        <div>
          <div className="mb-1.5 flex justify-between text-xs text-slate-500">
            <span>Story points delivered</span>
            <span>{sprint.done_points} / {sprint.total_points}</span>
          </div>
          <ProgressBar value={percent(sprint.done_points, sprint.total_points)} />
        </div>
        {open > 0 && (
          <Field label="Move open issues to">
            <Select
              value={target}
              onChange={setTarget}
              options={[
                { value: null, label: "Backlog" },
                ...plannedSprints.map((s) => ({ value: s.id as number | null, label: s.name })),
              ]}
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}
