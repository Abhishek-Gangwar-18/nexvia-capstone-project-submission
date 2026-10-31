import { MailOpen } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { EmptyState, PageLoader } from "@/components/ui/Misc";
import { useAcceptInvitation, useInvitationPreview, useRegister } from "@/hooks/queries";
import { ROLES } from "@/lib/constants";
import { getFieldErrors } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import { AuthLayout } from "./AuthLayout";

export default function AcceptInvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const access = useAuth((s) => s.access);
  const preview = useInvitationPreview(token);
  const accept = useAcceptInvitation();
  const register = useRegister();
  const [form, setForm] = useState({ first_name: "", last_name: "", password: "" });
  const errors = register.isError ? getFieldErrors(register.error) : {};

  if (preview.isLoading) return <PageLoader />;
  const invite = preview.data;
  if (!invite || !invite.is_pending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <EmptyState
          icon={<MailOpen className="size-6" />}
          title="This invitation is no longer valid"
          description="It may have expired or already been used. Ask a workspace admin to send a new one."
          action={<Link to="/"><Button variant="primary">Go to FlowBoard</Button></Link>}
        />
      </div>
    );
  }

  const join = () =>
    accept.mutate(token, {
      onSuccess: (workspace) => {
        toast.success(`You joined ${workspace.name}`);
        navigate(`/w/${workspace.slug}/dashboard`, { replace: true });
      },
    });

  const signUp = (event: FormEvent) => {
    event.preventDefault();
    register.mutate(
      { ...form, email: invite.email, invite_token: token },
      { onSuccess: (data) => navigate(`/w/${data.workspace}/dashboard`, { replace: true }) },
    );
  };

  const subtitle = (
    <>
      {invite.invited_by ?? "Someone"} invited <strong>{invite.email}</strong> to join{" "}
      <strong className="text-slate-900 dark:text-white">{invite.workspace}</strong> as {ROLES[invite.role].label.toLowerCase()}.
    </>
  );

  if (access && user) {
    const matches = user.email.toLowerCase() === invite.email.toLowerCase();
    return (
      <AuthLayout title="You're invited" subtitle={subtitle}>
        {matches ? (
          <Button variant="primary" size="lg" className="w-full" loading={accept.isPending} onClick={join}>
            Join {invite.workspace}
          </Button>
        ) : (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            You're logged in as <strong>{user.email}</strong>. Log out and sign in as {invite.email} to accept.
          </p>
        )}
      </AuthLayout>
    );
  }

  if (invite.user_exists) {
    return (
      <AuthLayout title="You're invited" subtitle={subtitle}>
        <Link to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>
          <Button variant="primary" size="lg" className="w-full">Log in to accept</Button>
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Join your team" subtitle={subtitle}>
      <form onSubmit={signUp} className="space-y-4">
        <Field label="Email">
          <Input value={invite.email} disabled />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" error={errors.first_name}>
            <Input required value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
          </Field>
          <Field label="Last name">
            <Input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
          </Field>
        </div>
        <Field label="Password" error={errors.password}>
          <Input type="password" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        {(errors.email || errors.invite_token) && <p className="text-sm text-rose-600">{errors.email || errors.invite_token}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={register.isPending}>
          Create account & join
        </Button>
      </form>
    </AuthLayout>
  );
}
