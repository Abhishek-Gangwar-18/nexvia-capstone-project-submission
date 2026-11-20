import { CheckCircle2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { useConfirmPasswordReset } from "@/hooks/queries";
import { getErrorMessage, getFieldErrors } from "@/lib/utils";
import { AuthLayout } from "./AuthLayout";

export default function ResetPasswordPage() {
  const { uid = "", token = "" } = useParams();
  const confirm = useConfirmPasswordReset();
  const [password, setPassword] = useState("");
  const errors = confirm.isError ? getFieldErrors(confirm.error) : {};
  const linkError = errors.token || errors.uid;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    confirm.mutate({ uid, token, new_password: password });
  };

  if (confirm.isSuccess) {
    return (
      <AuthLayout title="Password updated" subtitle="You've been signed out everywhere. Log in with your new password.">
        <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="size-4" /> Your password was changed.
        </p>
        <Link to="/login" className="mt-6 block">
          <Button variant="primary" size="lg" className="w-full">Go to log in</Button>
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Set a new password" subtitle="Choose a password you don't use anywhere else.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="New password" htmlFor="new_password" error={errors.new_password} hint="At least 8 characters, not too common.">
          <Input id="new_password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} invalid={!!errors.new_password} />
        </Field>
        {confirm.isError && !errors.new_password && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {linkError || getErrorMessage(confirm.error)}{" "}
            {linkError && <Link to="/forgot-password" className="font-semibold underline">Request a new link</Link>}
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={confirm.isPending}>
          Update password
        </Button>
      </form>
    </AuthLayout>
  );
}
