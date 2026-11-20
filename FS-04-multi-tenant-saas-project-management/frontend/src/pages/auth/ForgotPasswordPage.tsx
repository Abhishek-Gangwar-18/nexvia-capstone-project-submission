import { ArrowLeft, MailCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { useRequestPasswordReset } from "@/hooks/queries";
import { getErrorMessage } from "@/lib/utils";
import { AuthLayout } from "./AuthLayout";

export default function ForgotPasswordPage() {
  const request = useRequestPasswordReset();
  const [email, setEmail] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    request.mutate({ email });
  };

  return (
    <AuthLayout title="Forgot your password?" subtitle="Enter your email and we'll send you a link to set a new one.">
      {request.isSuccess ? (
        <div className="space-y-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          <p className="flex items-center gap-2 font-semibold"><MailCheck className="size-4" /> Check your inbox</p>
          <p>If an account exists for {email}, a reset link is on its way. It expires in one hour.</p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </Field>
          {request.isError && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
              {getErrorMessage(request.error)}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={request.isPending}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt-8 text-center text-sm">
        <Link to="/login" className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:text-brand-700 dark:text-brand-400">
          <ArrowLeft className="size-4" /> Back to log in
        </Link>
      </p>
    </AuthLayout>
  );
}
