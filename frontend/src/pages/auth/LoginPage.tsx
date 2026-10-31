import { ArrowRight, Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { useLogin } from "@/hooks/queries";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "@/lib/constants";
import { getErrorMessage } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import { AuthLayout } from "./AuthLayout";

export function safeNext(next: string | null) {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export default function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const access = useAuth((s) => s.access);
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Already signed in (and not mid-login): skip the form.
  if (access && login.isIdle) return <Navigate to={next} replace />;

  const submit = (event?: FormEvent, credentials = { email, password }) => {
    event?.preventDefault();
    login.mutate(credentials, { onSuccess: () => navigate(next, { replace: true }) });
  };

  return (
    <AuthLayout title="Welcome back" subtitle="Log in to your workspaces.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </Field>
        {login.isError && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {getErrorMessage(login.error)}
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={login.isPending}>
          Log in <ArrowRight className="size-4" />
        </Button>
      </form>

      <div className="mt-8 rounded-2xl border border-dashed border-brand-200 bg-brand-50/50 p-4 dark:border-brand-500/30 dark:bg-brand-500/5">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300">
          <Sparkles className="size-3.5" /> One-click demo accounts
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.email}
              type="button"
              disabled={login.isPending}
              onClick={() => {
                setEmail(account.email);
                setPassword(DEMO_PASSWORD);
                submit(undefined, { email: account.email, password: DEMO_PASSWORD });
              }}
              className="cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-left text-xs transition hover:border-brand-300 hover:shadow-sm disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900"
            >
              <span className="block font-semibold text-slate-800 dark:text-slate-200">{account.label}</span>
              <span className="block truncate text-slate-500">{account.email}</span>
            </button>
          ))}
        </div>
      </div>

      <p className="mt-8 text-center text-sm text-slate-500">
        New to FlowBoard?{" "}
        <Link to={`/register${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-semibold text-brand-600 hover:text-brand-700 dark:text-brand-400">
          Create an account
        </Link>
      </p>
    </AuthLayout>
  );
}
