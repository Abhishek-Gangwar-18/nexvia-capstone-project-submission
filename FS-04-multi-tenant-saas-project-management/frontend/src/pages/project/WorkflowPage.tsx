import { ArrowDown, ArrowUp, GitBranch, Plus, Save, Trash, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PageBody, PageHeader } from "@/components/layout/PageHeader";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select, type Option } from "@/components/ui/Select";
import { useSaveWorkflow, useWorkflow } from "@/hooks/queries";
import { usePermissions, useProjectContext } from "@/hooks/useWorkspace";
import type { StatusCategory, WorkflowStatus } from "@/types";

type StatusDraft = Omit<WorkflowStatus, "id"> & { id?: number; clientKey: string };
type RuleDraft = { from: string; to: string };
const categoryOptions: Option<StatusCategory>[] = [
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
];

export default function WorkflowPage() {
  const project = useProjectContext();
  const { isAdmin } = usePermissions();
  const workflow = useWorkflow(project.key);
  const save = useSaveWorkflow(project.key);
  const [name, setName] = useState("");
  const [enforce, setEnforce] = useState(false);
  const [statuses, setStatuses] = useState<StatusDraft[]>([]);
  const [rules, setRules] = useState<RuleDraft[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    if (!workflow.data) return;
    const loaded = workflow.data.statuses.map((status) => ({ ...status, clientKey: String(status.id) }));
    setName(workflow.data.name);
    setEnforce(workflow.data.enforce_transitions);
    setStatuses(loaded);
    setRules(
      workflow.data.transitions
        .map((rule) => ({ from: loaded[rule.from]?.clientKey, to: loaded[rule.to]?.clientKey }))
        .filter((rule) => rule.from && rule.to),
    );
  }, [workflow.data]);

  const statusOptions = useMemo<Option<string>[]>(
    () => statuses.map((status) => ({ value: status.clientKey, label: status.name || "Untitled status" })),
    [statuses],
  );
  const dirty =
    workflow.data &&
    (name !== workflow.data.name ||
      enforce !== workflow.data.enforce_transitions ||
      JSON.stringify(statuses.map(({ clientKey, ...s }) => s)) !== JSON.stringify(workflow.data.statuses) ||
      JSON.stringify(
        rules.map((rule) => ({
          from: statuses.findIndex((s) => s.clientKey === rule.from),
          to: statuses.findIndex((s) => s.clientKey === rule.to),
        })),
      ) !== JSON.stringify(workflow.data.transitions));

  const moveStatus = (index: number, direction: -1 | 1) =>
    setStatuses((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((status, position) => ({ ...status, position }));
    });
  const addStatus = () =>
    setStatuses((current) => [
      ...current,
      {
        clientKey: `new-${crypto.randomUUID()}`,
        name: "New status",
        category: "todo",
        color: "#64748b",
        position: current.length,
      },
    ]);
  const removeStatus = (key: string) => {
    setStatuses((current) =>
      current.filter((status) => status.clientKey !== key).map((status, position) => ({ ...status, position })),
    );
    setRules((current) => current.filter((rule) => rule.from !== key && rule.to !== key));
    setFrom((current) => (current === key ? "" : current));
    setTo((current) => (current === key ? "" : current));
  };
  const addRule = () => {
    if (!from || !to || from === to || rules.some((rule) => rule.from === from && rule.to === to)) return;
    setRules((current) => [...current, { from, to }]);
  };
  const submit = () => {
    save.mutate(
      {
        name,
        enforce_transitions: enforce,
        statuses: statuses.map(({ clientKey: _clientKey, ...status }) => status),
        transitions: rules.map((rule) => ({
          from: statuses.findIndex((s) => s.clientKey === rule.from),
          to: statuses.findIndex((s) => s.clientKey === rule.to),
        })),
      },
      { onSuccess: () => toast.success("Workflow saved") },
    );
  };

  if (workflow.isLoading) return <div className="p-8 text-sm text-slate-500">Loading workflow…</div>;
  if (workflow.isError || !workflow.data)
    return <div className="p-8 text-sm text-rose-600">Couldn't load this workflow.</div>;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <PageHeader
        title="Workflow"
        description={`Define the statuses and allowed moves for ${project.name}.`}
        icon={<GitBranch className="size-5 text-brand-600" />}
        actions={
          isAdmin && (
            <Button
              variant="primary"
              icon={<Save className="size-4" />}
              disabled={!dirty || save.isPending}
              loading={save.isPending}
              onClick={submit}
            >
              Save workflow
            </Button>
          )
        }
      />
      <PageBody className="max-w-4xl space-y-5">
        <section className="card space-y-4 p-5">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-600 dark:text-slate-300">
              Workflow name
            </label>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} disabled={!isAdmin} />
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
            <input
              type="checkbox"
              checked={enforce}
              onChange={(event) => setEnforce(event.target.checked)}
              disabled={!isAdmin}
              className="mt-0.5 accent-indigo-600"
            />
            <span>
              <span className="block text-sm font-medium">Restrict status transitions</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                When enabled, issues can move only along the rules listed below.
              </span>
            </span>
          </label>
          {enforce && rules.length === 0 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              With restrictions on and no rules, issues can't change status at all. Add at least one transition below.
            </p>
          )}
        </section>

        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
            <div>
              <h2 className="text-sm font-semibold">Statuses</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Column order is used on the Kanban board. Statuses with issues cannot be removed.
              </p>
            </div>
            {isAdmin && (
              <Button size="sm" icon={<Plus className="size-4" />} onClick={addStatus}>
                Add status
              </Button>
            )}
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {statuses.map((status, index) => (
              <div
                key={status.clientKey}
                className="grid grid-cols-[auto_minmax(120px,1fr)_150px_auto_auto] items-center gap-2 px-5 py-3 max-sm:grid-cols-[auto_1fr_auto]"
              >
                <input
                  aria-label="Status color"
                  type="color"
                  value={status.color}
                  disabled={!isAdmin}
                  onChange={(event) =>
                    setStatuses((current) =>
                      current.map((item) =>
                        item.clientKey === status.clientKey ? { ...item, color: event.target.value } : item,
                      ),
                    )
                  }
                  className="size-8 cursor-pointer rounded border-0 bg-transparent disabled:cursor-default"
                />
                <Input
                  aria-label="Status name"
                  value={status.name}
                  maxLength={40}
                  disabled={!isAdmin}
                  onChange={(event) =>
                    setStatuses((current) =>
                      current.map((item) =>
                        item.clientKey === status.clientKey ? { ...item, name: event.target.value } : item,
                      ),
                    )
                  }
                />
                <Select
                  value={status.category}
                  onChange={(category) =>
                    setStatuses((current) =>
                      current.map((item) => (item.clientKey === status.clientKey ? { ...item, category } : item)),
                    )
                  }
                  options={categoryOptions}
                  disabled={!isAdmin}
                  className="max-sm:col-start-2"
                />
                <span className="text-right text-xs text-slate-400">{index + 1}</span>
                {isAdmin && (
                  <span className="flex gap-0.5">
                    <IconButton label="Move status up" disabled={index === 0} onClick={() => moveStatus(index, -1)}>
                      <ArrowUp className="size-4" />
                    </IconButton>
                    <IconButton
                      label="Move status down"
                      disabled={index === statuses.length - 1}
                      onClick={() => moveStatus(index, 1)}
                    >
                      <ArrowDown className="size-4" />
                    </IconButton>
                    <IconButton
                      label="Remove status"
                      disabled={statuses.length <= 2}
                      onClick={() => removeStatus(status.clientKey)}
                    >
                      <Trash className="size-4 text-rose-500" />
                    </IconButton>
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="card space-y-4 p-5">
          <div>
            <h2 className="text-sm font-semibold">Allowed transitions</h2>
            <p className="mt-0.5 text-xs text-slate-500">Transitions are optional when restrictions are disabled.</p>
          </div>
          {isAdmin && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-44">
                <Select value={from} onChange={setFrom} options={statusOptions} placeholder="From status" />
              </div>
              <span className="text-slate-400">→</span>
              <div className="w-44">
                <Select value={to} onChange={setTo} options={statusOptions} placeholder="To status" />
              </div>
              <Button
                size="sm"
                icon={<Plus className="size-4" />}
                disabled={!from || !to || from === to || rules.some((rule) => rule.from === from && rule.to === to)}
                onClick={addRule}
              >
                Add
              </Button>
            </div>
          )}
          {rules.length === 0 ? (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60">
              No explicit transitions configured.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {rules.map((rule) => (
                <span
                  key={`${rule.from}-${rule.to}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs dark:border-slate-700"
                >
                  {statuses.find((s) => s.clientKey === rule.from)?.name}
                  <span className="text-slate-400">→</span>
                  {statuses.find((s) => s.clientKey === rule.to)?.name}
                  {isAdmin && (
                    <button
                      aria-label="Remove transition"
                      onClick={() => setRules((current) => current.filter((item) => item !== rule))}
                    >
                      <X className="ml-1 size-3 text-slate-400 hover:text-rose-500" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        </section>
      </PageBody>
    </div>
  );
}
