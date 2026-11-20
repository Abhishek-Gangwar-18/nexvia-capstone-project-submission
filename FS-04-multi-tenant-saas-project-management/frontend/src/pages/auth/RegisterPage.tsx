import { ArrowRight } from "lucide-react";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { useRegister } from "@/hooks/queries";
import { getFieldErrors } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import { AuthLayout } from "./AuthLayout";

export default function RegisterPage() {
  const navigate = useNavigate();
  const access = useAuth((s) => s.access);
  const register = useRegister();
  const [form, setForm] = useState({ first_name: "", last_name: "", email: "", password: "", workspace_name: "" });
  const errors = register.isError ? getFieldErrors(register.error) : {};

  if (access && register.isIdle) return <Navigate to="/" replace />;

  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    register.mutate(form, {
      onSuccess: (data) => navigate(data.workspace ? `/w/${data.workspace}/projects` : "/onboarding", { replace: true }),
    });
  };

  return (
    <AuthLayout title="Create your account" subtitle="Start a workspace for your team in seconds. No credit card required.">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" error={errors.first_name}>
            <Input required value={form.first_name} onChange={set("first_name")} autoComplete="given-name" />
          </Field>
          <Field label="Last name" error={errors.last_name}>
            <Input value={form.last_name} onChange={set("last_name")} autoComplete="family-name" />
          </Field>
        </div>
        <Field label="Work email" error={errors.email}>
          <Input type="email" required value={form.email} onChange={set("email")} autoComplete="email" invalid={!!errors.email} />
        </Field>
        <Field label="Password" error={errors.password} hint="At least 8 characters, not too common.">
          <Input type="password" required minLength={8} value={form.password} onChange={set("password")} autoComplete="new-password" invalid={!!errors.password} />
        </Field>
        <Field label="Workspace name" error={errors.workspace_name} hint="Usually your company or team.">
          <Input required value={form.workspace_name} onChange={set("workspace_name")} placeholder="Acme Inc." />
        </Field>
        {errors.detail && <p className="text-sm text-rose-600">{errors.detail}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={register.isPending}>
          Create workspace <ArrowRight className="size-4" />
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-slate-500">
        Already have an account?{" "}
        <Link to="/login" className="font-semibold text-brand-600 hover:text-brand-700 dark:text-brand-400">Log in</Link>
      </p>
    </AuthLayout>
  );
}
