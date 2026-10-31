import { Check, Columns3, ListTodo } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { memberOptions } from "@/components/issues/options";
import { useCreateProject, useMembers, useUpdateProject } from "@/hooks/queries";
import { useWorkspace } from "@/hooks/useWorkspace";
import { PROJECT_COLORS } from "@/lib/constants";
import { cn, getErrorMessage, getFieldErrors } from "@/lib/utils";
import type { BoardType, Project } from "@/types";

function suggestKey(name: string) {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  const key = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "").slice(0, 4);
  return /^[A-Z]/.test(key) ? key.slice(0, 10) : "";
}

export function ProjectFormModal({ open, onClose, project }: { open: boolean; onClose: () => void; project?: Project }) {
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const members = useMembers().data ?? [];
  const create = useCreateProject();
  const update = useUpdateProject(project?.key ?? "");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(PROJECT_COLORS[0]);
  const [lead, setLead] = useState<number | null>(null);
  const [boardType, setBoardType] = useState<BoardType>("scrum");
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setKey(project?.key ?? "");
    setKeyTouched(!!project);
    setDescription(project?.description ?? "");
    setColor(project?.color ?? PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)]);
    setLead(project?.lead ?? null);
    setBoardType(project?.board?.board_type ?? "scrum");
    setErrors({});
  }, [open, project]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setErrors({});
    const body = { name, description, color, lead };
    const onError = (error: unknown) => {
      const fields = getFieldErrors(error);
      setErrors(fields);
      if (!Object.keys(fields).some((f) => ["name", "key"].includes(f))) toast.error(getErrorMessage(error));
    };
    if (project) {
      update.mutate(body, {
        onSuccess: () => {
          toast.success("Project updated");
          onClose();
        },
      });
    } else {
      create.mutate(
        { ...body, key, board_type: boardType },
        {
          onSuccess: (created) => {
            toast.success(`${created.name} is ready`);
            onClose();
            navigate(`/w/${workspace.slug}/projects/${created.key}/board`);
          },
          onError,
        },
      );
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" title={project ? "Project settings" : "Create project"} description={project ? project.key : "A project groups issues, a workflow, a board and sprints."}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
          <Field label="Name" error={errors.name}>
            <Input
              autoFocus
              required
              maxLength={120}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!keyTouched) setKey(suggestKey(e.target.value));
              }}
              placeholder="Website Revamp"
            />
          </Field>
          <Field label="Key" error={errors.key} hint={project ? "Can't change" : "Prefix for issue keys"}>
            <Input
              required
              disabled={!!project}
              value={key}
              maxLength={10}
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
              }}
              placeholder="WEB"
              className="font-mono uppercase"
              invalid={!!errors.key}
            />
          </Field>
        </div>
        <Field label="Description">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this project about?" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Project lead">
            <Select value={lead} onChange={setLead} options={memberOptions(members, "No lead")} />
          </Field>
          <Field label="Colour">
            <div className="flex h-9 flex-wrap items-center gap-1.5">
              {PROJECT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Colour ${c}`}
                  onClick={() => setColor(c)}
                  className={cn("flex size-6 cursor-pointer items-center justify-center rounded-md transition hover:scale-110", color === c && "ring-2 ring-offset-2 ring-slate-400 dark:ring-offset-slate-900")}
                  style={{ backgroundColor: c }}
                >
                  {color === c && <Check className="size-3.5 text-white" strokeWidth={3} />}
                </button>
              ))}
            </div>
          </Field>
        </div>
        {!project && (
          <Field label="Board type">
            <div className="grid grid-cols-2 gap-3">
              {([
                ["scrum", ListTodo, "Scrum", "Plan work in time-boxed sprints."],
                ["kanban", Columns3, "Kanban", "Continuous flow, no sprints."],
              ] as const).map(([value, Icon, label, text]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setBoardType(value)}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-xl border p-3 text-left transition",
                    boardType === value
                      ? "border-brand-500 bg-brand-50/60 ring-4 ring-brand-500/10 dark:bg-brand-500/10"
                      : "border-slate-200 hover:border-slate-300 dark:border-slate-700",
                  )}
                >
                  <Icon className={cn("mt-0.5 size-5", boardType === value ? "text-brand-600" : "text-slate-400")} />
                  <span>
                    <span className="block text-sm font-semibold">{label}</span>
                    <span className="block text-xs text-slate-500">{text}</span>
                  </span>
                </button>
              ))}
            </div>
          </Field>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending || update.isPending} disabled={!name.trim() || !key}>
            {project ? "Save changes" : "Create project"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
