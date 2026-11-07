import { Check, CreditCard, ExternalLink, TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { PageBody, PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { ProgressBar, Skeleton } from "@/components/ui/Misc";
import { useBilling, useCheckout, usePortal, useSyncBilling } from "@/hooks/queries";
import { useWorkspace } from "@/hooks/useWorkspace";
import { PLANS } from "@/lib/constants";
import { cn, formatDate, percent } from "@/lib/utils";
import type { BillingPlan, Plan } from "@/types";

function Meter({ label, used, limit, note }: { label: string; used: number; limit: number | null; note?: string }) {
  const atLimit = limit !== null && used >= limit;
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className={cn("tabular-nums", atLimit ? "font-semibold text-rose-600 dark:text-rose-400" : "text-slate-500")}>
          {used} / {limit ?? "Unlimited"}
        </span>
      </div>
      <ProgressBar className="mt-1.5" value={limit === null ? 0 : percent(used, limit)} color={atLimit ? "bg-rose-500" : "bg-brand-500"} />
      {note && <p className="mt-1 text-xs text-slate-500">{note}</p>}
    </div>
  );
}

const limitText = (value: number | null, noun: string) => (value === null ? `Unlimited ${noun}` : `Up to ${value} ${noun}`);

export default function BillingPage() {
  const workspace = useWorkspace();
  const { data, isLoading } = useBilling();
  const checkout = useCheckout();
  const portal = usePortal();
  const sync = useSyncBilling();
  const [params, setParams] = useSearchParams();
  const handled = useRef(false);
  const returned = params.get("checkout");
  const canManage = data?.can_manage;

  // Back from Stripe: read the result directly, because webhooks can't always reach a local machine.
  useEffect(() => {
    if (!returned || canManage === undefined || handled.current) return;
    handled.current = true;
    setParams({}, { replace: true });
    if (returned === "cancelled") {
      toast("Checkout cancelled. Nothing was charged.");
    } else if (canManage) {
      sync.mutate(undefined, {
        onSuccess: (state) => {
          if (returned === "success") toast.success(`You're on the ${PLANS[state.plan].label} plan`);
        },
      });
    }
  }, [returned, canManage]); // eslint-disable-line react-hooks/exhaustive-deps -- runs once per return from Stripe

  if (isLoading || !data) {
    return (
      <PageBody className="space-y-4 pt-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40" />
        <Skeleton className="h-72" />
      </PageBody>
    );
  }

  const current = data.plans.find((p) => p.id === data.plan) ?? data.plans[0];
  const subscription = data.subscription;
  const subscribed = !!subscription && ["active", "trialing", "past_due"].includes(subscription.status);
  const busy = checkout.isPending || portal.isPending;
  const toStripe = { onSuccess: ({ url }: { url: string }) => window.location.assign(url) };

  const action = (plan: BillingPlan) => {
    if (plan.id === data.plan) return <Button className="w-full" disabled>Current plan</Button>;
    if (!data.can_manage || !data.stripe_configured) return null;
    if (subscribed) {
      return (
        <Button className="w-full" loading={portal.isPending} disabled={busy} onClick={() => portal.mutate(undefined, toStripe)}>
          Change in Stripe
        </Button>
      );
    }
    if (plan.id === "free") return null;
    return (
      <Button
        variant="primary"
        className="w-full"
        loading={checkout.isPending && checkout.variables === plan.id}
        disabled={busy}
        onClick={() => checkout.mutate(plan.id as Plan, toStripe)}
      >
        Upgrade to {plan.name}
      </Button>
    );
  };

  return (
    <>
      <PageHeader
        title="Billing"
        description={`Plan and usage for ${workspace.name}.`}
        actions={
          data.can_manage && data.has_billing_account && data.stripe_configured && (
            <Button icon={<ExternalLink className="size-4" />} loading={portal.isPending} disabled={busy} onClick={() => portal.mutate(undefined, toStripe)}>
              Manage billing
            </Button>
          )
        }
      />
      <PageBody className="max-w-5xl space-y-5">
        {subscription?.status === "past_due" && (
          <p className="flex items-center gap-2 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:bg-rose-500/10 dark:text-rose-300">
            <TriangleAlert className="size-4 shrink-0" /> Your last payment failed. Update your card to keep this plan.
          </p>
        )}
        {subscription?.cancel_at_period_end && subscription.current_period_end && (
          <p className="flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            <TriangleAlert className="size-4 shrink-0" /> Your subscription ends on {formatDate(subscription.current_period_end)}, then this workspace moves to Free.
          </p>
        )}
        {(data.over_limit.projects || data.over_limit.members) && (
          <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              This workspace is over the {current.name} plan
              {data.over_limit.projects && ` (${data.over_limit.projects.used}/${data.over_limit.projects.limit} active projects)`}
              {data.over_limit.members && ` (${data.over_limit.members.used}/${data.over_limit.members.limit} members incl. invitations)`}.
              Everything you have keeps working: you can view, edit and delete it. Adding more is blocked until you
              upgrade, or archive projects and remove members.
            </span>
          </p>
        )}
        {!data.stripe_configured && (
          <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            Billing isn't configured on this server. Limits still apply.
          </p>
        )}

        <section className="card grid gap-6 p-6 md:grid-cols-[240px_1fr]">
          <div>
            <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <CreditCard className="size-4" />
            </span>
            <p className="mt-3 text-xs text-slate-500">Current plan</p>
            <p className="text-2xl font-bold">{current.name}</p>
            {subscribed && subscription.current_period_end && !subscription.cancel_at_period_end && (
              <p className="mt-1 text-xs text-slate-500">Renews {formatDate(subscription.current_period_end)}</p>
            )}
            {!subscription && data.plan !== "free" && <p className="mt-1 text-xs text-slate-500">Demo plan, not billed through Stripe.</p>}
          </div>
          <div className="space-y-4">
            <Meter label="Active projects" used={data.usage.projects} limit={current.projects} />
            <Meter
              label="Members"
              used={data.usage.members + data.usage.pending_invitations}
              limit={current.members}
              note={data.usage.pending_invitations ? `Includes ${data.usage.pending_invitations} pending invitations.` : undefined}
            />
            <p className="text-sm text-slate-500">Files up to {current.file_mb} MB each.</p>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {data.plans.map((plan) => (
            <section key={plan.id} className={cn("card flex flex-col p-5", plan.id === data.plan && "border-brand-500 ring-4 ring-brand-500/10")}>
              <h2 className="font-semibold">{plan.name}</h2>
              <p className="mt-1">
                <span className="text-3xl font-bold">${plan.price_monthly}</span>
                <span className="text-sm text-slate-500"> / month</span>
              </p>
              <ul className="mt-4 mb-5 flex-1 space-y-2 text-sm text-slate-600 dark:text-slate-400">
                {[limitText(plan.projects, "projects"), limitText(plan.members, "members"), `Files up to ${plan.file_mb} MB`, ...plan.features].map((line) => (
                  <li key={line} className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-brand-600 dark:text-brand-400" /> {line}
                  </li>
                ))}
              </ul>
              {action(plan)}
            </section>
          ))}
        </div>
        {!data.can_manage && <p className="text-sm text-slate-500">Only the workspace owner can change the plan.</p>}
      </PageBody>
    </>
  );
}
