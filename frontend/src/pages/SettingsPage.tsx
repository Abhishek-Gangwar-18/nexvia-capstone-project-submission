import { Building, Check, Copy, CreditCard, Globe, Plus, Send, Tag, Trash, TriangleAlert } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { PageBody, PageHeader } from "@/components/layout/PageHeader";
import { LabelChip } from "@/components/issues/IssueMeta";
import { Button, IconButton } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/Modal";
import { useCreateLabel, useCreateWebhook, useDeleteLabel, useDeleteWebhook, useDeleteWorkspace, useGenerateWorkspaceReport, useLabels, useRotateWebhookSecret, useTestWebhook, useUpdateWorkspace, useWebhookDeliveries, useWebhooks, useWorkspaceReports } from "@/hooks/queries";
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
  const webhooks = useWebhooks(isAdmin);
  const createWebhook = useCreateWebhook();
  const deleteWebhook = useDeleteWebhook();
  const testWebhook = useTestWebhook();
  const rotateSecret = useRotateWebhookSecret();
  const [webhookName, setWebhookName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookEvents, setWebhookEvents] = useState<string[]>(["issue.created", "issue.updated"]);
  const [selectedWebhook, setSelectedWebhook] = useState<number | null>(null);
  const deliveries = useWebhookDeliveries(selectedWebhook);
  const reports = useWorkspaceReports();
  const generateReport = useGenerateWorkspaceReport();
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
            <Button disabled title="Subscription management is enabled with Stripe billing">Manage billing</Button>
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

        <Section icon={<Globe className="size-4" />} title="Webhooks" description="Send signed issue events to your integrations. Delivery attempts retry automatically with backoff.">
          {isAdmin && <form onSubmit={(event) => { event.preventDefault(); createWebhook.mutate({ name: webhookName.trim(), url: webhookUrl.trim(), events: webhookEvents }, { onSuccess: (endpoint) => { setWebhookName(""); setWebhookUrl(""); setSelectedWebhook(endpoint.id); toast.success("Webhook added. Copy its signing secret now."); }, onError: () => toast.error("Couldn't add webhook. Check URL and event selections.") }); }} className="mb-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Input value={webhookName} onChange={(e) => setWebhookName(e.target.value)} placeholder="Webhook name" maxLength={100} />
            <Input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://example.com/hooks" type="url" />
            <Button type="submit" icon={<Plus className="size-4" />} loading={createWebhook.isPending} disabled={!webhookName.trim() || !webhookUrl.trim()}>Add webhook</Button>
            <div className="flex flex-wrap gap-x-3 gap-y-1 sm:col-span-3">{["issue.created", "issue.updated", "issue.moved", "issue.commented", "issue.attached", "issue.detached", "issue.deleted"].map((event) => <label key={event} className="flex items-center gap-1.5 text-[11px] text-slate-500"><input type="checkbox" checked={webhookEvents.includes(event)} onChange={(e) => setWebhookEvents((current) => e.target.checked ? [...current, event] : current.filter((item) => item !== event))} className="accent-indigo-600" />{event}</label>)}</div>
          </form>}
          <div className="space-y-2">{(webhooks.data ?? []).map((endpoint) => <div key={endpoint.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"><div className="flex flex-wrap items-start gap-2"><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{endpoint.name}</p><p className="truncate font-mono text-[11px] text-slate-500">{endpoint.url}</p><p className="mt-1 text-[10px] text-slate-400">Events: {endpoint.events.join(", ") || "none"}</p></div>{isAdmin && <><IconButton label="Copy webhook secret" onClick={() => { navigator.clipboard.writeText(endpoint.secret); toast.success("Signing secret copied"); }}><Copy className="size-4" /></IconButton><IconButton label="Rotate webhook secret" onClick={() => rotateSecret.mutate(endpoint.id, { onSuccess: ({ secret }) => { navigator.clipboard.writeText(secret); toast.success("Secret rotated and copied"); }, onError: () => toast.error("Couldn't rotate secret") })}><span className="text-xs font-bold">↻</span></IconButton><IconButton label="Send test webhook" onClick={() => testWebhook.mutate(endpoint.id, { onSuccess: () => toast.success("Test delivery queued"), onError: () => toast.error("Couldn't queue test") })}><Send className="size-4" /></IconButton><IconButton label="Delete webhook" onClick={() => deleteWebhook.mutate(endpoint.id, { onSuccess: () => toast.success("Webhook deleted") })}><Trash className="size-4 text-rose-500" /></IconButton></>}</div><button onClick={() => setSelectedWebhook((current) => current === endpoint.id ? null : endpoint.id)} className="mt-2 text-[11px] font-medium text-brand-600">{selectedWebhook === endpoint.id ? "Hide deliveries" : "View recent deliveries"}</button>{selectedWebhook === endpoint.id && <div className="mt-2 space-y-1 border-t border-slate-100 pt-2 dark:border-slate-800">{(deliveries.data ?? []).length ? deliveries.data?.map((delivery) => <div key={delivery.id} className="flex flex-wrap items-center gap-2 text-[10px]"><span className={`rounded px-1.5 py-0.5 font-semibold ${delivery.state === "delivered" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : delivery.state === "failed" ? "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300" : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"}`}>{delivery.state}</span><span className="font-mono">{delivery.event}</span><span className="text-slate-400">{delivery.attempts} attempts · HTTP {delivery.response_status ?? "—"}</span>{delivery.last_error && <span className="basis-full text-rose-500">{delivery.last_error}</span>}</div>) : <p className="text-[11px] text-slate-400">No deliveries yet.</p>}</div>}</div>)}{isAdmin && (webhooks.data ?? []).length === 0 && <p className="text-xs text-slate-400">No webhooks configured.</p>}{!isAdmin && <p className="text-xs text-slate-400">Webhook settings are managed by workspace admins.</p>}</div>
        </Section>

        <Section icon={<Copy className="size-4" />} title="Background reports" description="Generate an issue summary asynchronously. You can keep working while it runs.">
          <Button icon={<Plus className="size-4" />} loading={generateReport.isPending} onClick={() => generateReport.mutate(undefined, { onSuccess: () => toast.success("Report queued"), onError: () => toast.error("Couldn't queue report") })}>Generate report</Button>
          <div className="mt-3 space-y-2">{(reports.data ?? []).slice(0, 5).map((report) => <div key={report.id} className="rounded-lg bg-slate-50 px-3 py-2 text-xs dark:bg-slate-800/60"><span className="font-semibold capitalize">{report.report_type.replaceAll("_", " ")}</span><span className="ml-2 text-slate-500">{report.state}</span>{report.state === "ready" && <span className="ml-2 text-slate-500">{String(report.data.issue_count ?? 0)} issues</span>}{report.error && <p className="mt-1 text-rose-500">{report.error}</p>}</div>)}</div>
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
