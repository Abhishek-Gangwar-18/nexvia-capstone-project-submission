import { Building, Check, CreditCard, Globe, Plus, Tag, Trash, TriangleAlert } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { PageBody, PageHeader } from "@/components/layout/PageHeader";
import { LabelChip } from "@/components/issues/IssueMeta";
import { WebhooksSection } from "@/components/settings/AutomationSections";
import { Button, IconButton } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/Modal";
import { useCreateLabel, useDeleteLabel, useDeleteWorkspace, useLabels, useUpdateWorkspace } from "@/hooks/queries";
import { usePermissions, useWorkspace } from "@/hooks/useWorkspace";
import { PLANS, PROJECT_COLORS } from "@/lib/constants";
import { cn, formatDate } from "@/lib/utils";
import { useUI } from "@/store/ui";

function Section({ icon, title, description, children, danger }: { icon: ReactNode; title: string; description: string; children: ReactNode; danger?: boolean }) {
  return (
    <section className={cn("card grid gap-6 p-6 md:grid-cols-[260px_1fr]", danger && "border-rose-200 dark:border-rose-500/30")}>
      <div>
        <div className={cn("mb-2 flex size-9 items-center justify-center rounded-xl", danger ? "bg-rose-50 text-rose-600 dark:bg-rose-500/10" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")}>
          {icon}
        </div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-slate-500">{description}</p>
      </div>
      <div>{children}</div>
    </section>
  );
}

export default function SettingsPage() {
  const workspace = useWorkspace();
  const { isAdmin, isOwner, canEdit } = usePermissions();
  const update = useUpdateWorkspace();
  const remove = useDeleteWorkspace();
  const labels = useLabels().data ?? [];
  const createLabel = useCreateLabel();
  const deleteLabel = useDeleteLabel();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const setLastWorkspace = useUI((s) => s.setLastWorkspace);
  const [name, setName] = useState(workspace.name);
  const [labelName, setLabelName] = useState("");
  const [labelColor, setLabelColor] = useState(PROJECT_COLORS[0]);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => setName(workspace.name), [workspace.name]);

  const saveName = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ name }, { onSuccess: () => toast.success("Workspace renamed") });
  };

  const addLabel = (event: FormEvent) => {
    event.preventDefault();
    createLabel.mutate(
      { name: labelName, color: labelColor },
      { onSuccess: () => { setLabelName(""); toast.success("Label created"); } },
    );
  };

  return (
    <>
      <PageHeader title="Settings" description={`Manage ${workspace.name}.`} />
      <PageBody className="max-w-5xl space-y-5">
        <Section icon={<Building className="size-4" />} title="General" description="Your workspace's name and address.">
          <form onSubmit={saveName} className="space-y-4">
            <Field label="Workspace name">
              <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} maxLength={100} />
            </Field>
            <Field label="Workspace URL" hint="Used in links and the X-Workspace API header.">
              <Input value={`/w/${workspace.slug}`} disabled className="font-mono" />
            </Field>
            <p className="text-xs text-slate-500">
              Created {formatDate(workspace.created_at)} · Owner {workspace.owner.display_name}
            </p>
            {isAdmin && (
              <Button type="submit" variant="primary" loading={update.isPending} disabled={!name.trim() || name === workspace.name}>
                Save
              </Button>
            )}
          </form>
        </Section>

        <Section icon={<CreditCard className="size-4" />} title="Plan" description="Your subscription determines project and member limits.">
          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <span className={cn("rounded-lg px-2.5 py-1 text-sm font-bold", PLANS[workspace.plan].badge)}>{PLANS[workspace.plan].label}</span>
            <div className="flex-1 text-sm text-slate-500">
              {workspace.member_count} members · {workspace.project_count} active projects
            </div>
            <Link to={`/w/${workspace.slug}/billing`}><Button>Manage billing</Button></Link>
          </div>
        </Section>

        <Section icon={<Tag className="size-4" />} title="Labels" description="Shared across every project in this workspace.">
          <div className="flex flex-wrap gap-2">
            {labels.map((label) => (
              <span key={label.id} className="group inline-flex items-center gap-1 rounded-lg border border-slate-200 py-1 pr-1 pl-2 dark:border-slate-700">
                <LabelChip label={label} />
                {isAdmin && (
                  <IconButton label={`Delete ${label.name}`} className="size-5" onClick={() => deleteLabel.mutate(label.id)}>
                    <Trash className="size-3" />
                  </IconButton>
                )}
              </span>
            ))}
            {labels.length === 0 && <p className="text-sm text-slate-400">No labels yet.</p>}
          </div>
          {canEdit && (
            <form onSubmit={addLabel} className="mt-4 flex flex-wrap items-end gap-3">
              <Field label="New label" className="w-48">
                <Input value={labelName} onChange={(e) => setLabelName(e.target.value)} placeholder="e.g. frontend" maxLength={40} />
              </Field>
              <div className="flex h-9 items-center gap-1">
                {PROJECT_COLORS.slice(0, 8).map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Colour ${c}`}
                    onClick={() => setLabelColor(c)}
                    className={cn("flex size-5 cursor-pointer items-center justify-center rounded-full", labelColor === c && "ring-2 ring-slate-400 ring-offset-1 dark:ring-offset-slate-900")}
                    style={{ backgroundColor: c }}
                  >
                    {labelColor === c && <Check className="size-3 text-white" strokeWidth={3} />}
                  </button>
                ))}
              </div>
              <Button type="submit" icon={<Plus className="size-4" />} loading={createLabel.isPending} disabled={!labelName.trim()}>
                Add
              </Button>
            </form>
          )}
        </Section>

        <Section icon={<Globe className="size-4" />} title="Webhooks" description="Send signed issue events to your integrations. Failed deliveries retry automatically with backoff.">
          <WebhooksSection />
        </Section>


        {isOwner && (
          <Section danger icon={<TriangleAlert className="size-4" />} title="Danger zone" description="Deleting a workspace removes all of its data. This can't be undone.">
            <Button variant="danger" icon={<Trash className="size-4" />} onClick={() => setConfirming(true)}>
              Delete workspace
            </Button>
          </Section>
        )}
      </PageBody>

      <ConfirmDialog
        open={confirming}
        onClose={() => { setConfirming(false); setConfirmText(""); }}
        title={`Delete ${workspace.name}?`}
        description="Every project, issue, sprint, label and membership will be permanently deleted."
        confirmLabel="Delete forever"
        loading={remove.isPending}
        onConfirm={() => {
          if (confirmText !== workspace.slug) {
            toast.error(`Type ${workspace.slug} to confirm`);
            return;
          }
          remove.mutate(undefined, {
            onSuccess: async () => {
              setLastWorkspace(null);
              await qc.invalidateQueries({ queryKey: ["workspaces"] });
              toast.success("Workspace deleted");
              navigate("/", { replace: true });
            },
          });
        }}
      >
        <label className="block text-sm text-slate-600 dark:text-slate-400">
          Type <strong className="font-mono">{workspace.slug}</strong> to confirm.
          <Input className="mt-2 font-mono" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
        </label>
      </ConfirmDialog>
    </>
  );
}
