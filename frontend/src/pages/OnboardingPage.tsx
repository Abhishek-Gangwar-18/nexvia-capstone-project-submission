import { ArrowRight, Building } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { useLogout } from "@/components/layout/Topbar";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { Logo, PageLoader } from "@/components/ui/Misc";
import { useCreateWorkspace, useWorkspaces } from "@/hooks/queries";
import { useAuth } from "@/store/auth";

export default function OnboardingPage() {
  const user = useAuth((s) => s.user);
  const { data: workspaces, isLoading } = useWorkspaces();
  const create = useCreateWorkspace();
  const navigate = useNavigate();
  const logout = useLogout();
  const [name, setName] = useState("");

  if (isLoading) return <PageLoader />;
  if (workspaces && workspaces.length > 0 && !create.isSuccess) return <Navigate to="/" replace />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ name }, { onSuccess: (ws) => navigate(`/w/${ws.slug}/projects`, { replace: true }) });
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-brand-50 to-white p-6 dark:from-slate-900 dark:to-slate-950">
      <Logo className="mb-10 text-lg" />
      <div className="card animate-slide-up w-full max-w-md p-8">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-lg shadow-brand-600/30">
          <Building className="size-5" />
        </span>
        <h1 className="mt-5 text-xl font-bold">Create your first workspace</h1>
        <p className="mt-1.5 text-sm text-slate-500">
          Hi {user?.display_name ?? "there"}, a workspace holds your team's projects, boards and sprints. Got an invite? Open the
          invitation link instead.
        </p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label="Workspace name">
            <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={create.isPending} disabled={!name.trim()}>
            Continue <ArrowRight className="size-4" />
          </Button>
        </form>
      </div>
      <button onClick={logout} className="mt-6 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
        Log out
      </button>
    </div>
  );
}
