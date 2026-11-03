import { Copy, Plus, RotateCw, Send, Trash } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/Modal";
import {
  useCreateWebhook, useDeleteWebhook, useRotateWebhookSecret, useTestWebhook, useWebhookDeliveries, useWebhooks,
} from "@/hooks/queries";
import { usePermissions } from "@/hooks/useWorkspace";
import { cn, pluralize } from "@/lib/utils";
import type { WebhookDelivery, WebhookEndpoint } from "@/types";

const WEBHOOK_EVENTS = [
  "issue.created", "issue.updated", "issue.moved", "issue.commented", "issue.attached", "issue.detached", "issue.deleted",
];

const DELIVERY_BADGE: Record<WebhookDelivery["state"], string> = {
  delivered: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  failed: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
  pending: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
};

export function WebhooksSection() {
  const { isAdmin } = usePermissions();
  const webhooks = useWebhooks(isAdmin);
  const create = useCreateWebhook();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["issue.created", "issue.updated"]);
  const [openId, setOpenId] = useState<number | null>(null);

  if (!isAdmin) return <p className="text-xs text-slate-400">Webhook settings are managed by workspace admins.</p>;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name: name.trim(), url: url.trim(), events },
      {
        onSuccess: (endpoint) => {
          setName("");
          setUrl("");
          setOpenId(endpoint.id);
          toast.success("Webhook added");
        },
      },
    );
  };

  const endpoints = webhooks.data ?? [];
  return (
    <>
      <form onSubmit={submit} className="mb-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Webhook name" maxLength={100} />
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks" type="url" />
        <Button
          type="submit"
          icon={<Plus className="size-4" />}
          loading={create.isPending}
          disabled={!name.trim() || !url.trim() || events.length === 0}
        >
          Add webhook
        </Button>
        <div className="flex flex-wrap gap-x-3 gap-y-1 sm:col-span-3">
          {WEBHOOK_EVENTS.map((item) => (
            <label key={item} className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <input
                type="checkbox"
                checked={events.includes(item)}
                onChange={(e) => setEvents((list) => (e.target.checked ? [...list, item] : list.filter((x) => x !== item)))}
                className="accent-brand-600"
              />
              {item}
            </label>
          ))}
        </div>
      </form>
      <div className="space-y-2">
        {endpoints.length === 0 && <p className="text-xs text-slate-400">No webhooks configured.</p>}
        {endpoints.map((endpoint) => (
          <WebhookRow
            key={endpoint.id}
            endpoint={endpoint}
            open={openId === endpoint.id}
            onToggle={() => setOpenId((current) => (current === endpoint.id ? null : endpoint.id))}
          />
        ))}
      </div>
    </>
  );
}

function WebhookRow({ endpoint, open, onToggle }: { endpoint: WebhookEndpoint; open: boolean; onToggle: () => void }) {
  const remove = useDeleteWebhook();
  const test = useTestWebhook();
  const rotate = useRotateWebhookSecret();
  const [confirming, setConfirming] = useState(false);
  const deliveries = useWebhookDeliveries(open ? endpoint.id : null);
  const list = deliveries.data ?? [];

  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Delete ${endpoint.name}?`}
        description="Its delivery history is deleted too, and events stop being sent."
        loading={remove.isPending}
        onConfirm={() => remove.mutate(endpoint.id, { onSuccess: () => toast.success("Webhook deleted") })}
      />
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{endpoint.name}</p>
          <p className="truncate font-mono text-[11px] text-slate-500">{endpoint.url}</p>
          <p className="mt-1 text-[10px] text-slate-400">Events: {endpoint.events.join(", ") || "none"}</p>
        </div>
        <IconButton
          label="Copy signing secret"
          onClick={() => {
            navigator.clipboard.writeText(endpoint.secret);
            toast.success("Signing secret copied");
          }}
        >
          <Copy className="size-4" />
        </IconButton>
        <IconButton
          label="Rotate signing secret"
          onClick={() =>
            rotate.mutate(endpoint.id, {
              onSuccess: ({ secret }) => {
                navigator.clipboard.writeText(secret);
                toast.success("Secret rotated and copied");
              },
            })
          }
        >
          <RotateCw className="size-4" />
        </IconButton>
        <IconButton
          label="Send test event"
          onClick={() => test.mutate(endpoint.id, { onSuccess: () => toast.success("Test delivery queued") })}
        >
          <Send className="size-4" />
        </IconButton>
        <IconButton
          label="Delete webhook"
          onClick={() => setConfirming(true)}
        >
          <Trash className="size-4 text-rose-500" />
        </IconButton>
      </div>
      <button onClick={onToggle} className="mt-2 cursor-pointer text-[11px] font-medium text-brand-600">
        {open ? "Hide deliveries" : "View recent deliveries"}
      </button>
      {open && (
        <div className="mt-2 space-y-1 border-t border-slate-100 pt-2 dark:border-slate-800">
          {list.length === 0 && <p className="text-[11px] text-slate-400">No deliveries yet.</p>}
          {list.map((delivery) => (
            <div key={delivery.id} className="flex flex-wrap items-center gap-2 text-[10px]">
              <span className={cn("rounded px-1.5 py-0.5 font-semibold", DELIVERY_BADGE[delivery.state])}>{delivery.state}</span>
              <span className="font-mono">{delivery.event}</span>
              <span className="text-slate-400">
                {pluralize(delivery.attempts, "attempt")} · HTTP {delivery.response_status ?? "—"}
              </span>
              {delivery.last_error && <span className="basis-full text-rose-500">{delivery.last_error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
