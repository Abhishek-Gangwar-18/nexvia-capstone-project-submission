import { Check, KeyRound, User } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { PageBody, PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { Avatar } from "@/components/ui/Misc";
import { useChangePassword, useUpdateMe } from "@/hooks/queries";
import { AVATAR_COLORS } from "@/lib/constants";
import { cn, formatDate, getFieldErrors } from "@/lib/utils";
import { useAuth } from "@/store/auth";

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="card p-6">
      <h2 className="mb-5 flex items-center gap-2 text-sm font-semibold">
        <span className="text-slate-400">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function ProfilePage() {
  const user = useAuth((s) => s.user);
  const updateMe = useUpdateMe();
  const changePassword = useChangePassword();
  const [profile, setProfile] = useState({ first_name: "", last_name: "", job_title: "", avatar_color: AVATAR_COLORS[0] });
  const [passwords, setPasswords] = useState({ current_password: "", new_password: "" });
  const passwordErrors = changePassword.isError ? getFieldErrors(changePassword.error) : {};

  useEffect(() => {
    if (user) {
      setProfile({ first_name: user.first_name, last_name: user.last_name, job_title: user.job_title, avatar_color: user.avatar_color });
    }
  }, [user]);

  if (!user) return null;
  const preview = {
    ...user,
    avatar_color: profile.avatar_color,
    initials: `${profile.first_name[0] ?? ""}${profile.last_name[0] ?? ""}`.toUpperCase() || user.initials,
  };

  const saveProfile = (event: FormEvent) => {
    event.preventDefault();
    updateMe.mutate(profile, { onSuccess: () => toast.success("Profile updated") });
  };

  const savePassword = (event: FormEvent) => {
    event.preventDefault();
    changePassword.mutate(passwords, {
      onSuccess: () => {
        toast.success("Password changed");
        setPasswords({ current_password: "", new_password: "" });
      },
    });
  };

  return (
    <>
      <PageHeader title="Profile & security" description={`Member since ${formatDate(user.date_joined)}`} />
      <PageBody className="grid max-w-5xl gap-5 lg:grid-cols-2">
        <Card icon={<User className="size-4" />} title="Profile">
          <form onSubmit={saveProfile} className="space-y-4">
            <div className="flex items-center gap-4">
              <Avatar user={preview} size="xl" />
              <div>
                <p className="font-semibold">{user.email}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {AVATAR_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Avatar colour ${c}`}
                      onClick={() => setProfile((p) => ({ ...p, avatar_color: c }))}
                      className={cn("flex size-6 cursor-pointer items-center justify-center rounded-full transition hover:scale-110", profile.avatar_color === c && "ring-2 ring-slate-400 ring-offset-2 dark:ring-offset-slate-900")}
                      style={{ backgroundColor: c }}
                    >
                      {profile.avatar_color === c && <Check className="size-3.5 text-white" strokeWidth={3} />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name">
                <Input value={profile.first_name} onChange={(e) => setProfile({ ...profile, first_name: e.target.value })} />
              </Field>
              <Field label="Last name">
                <Input value={profile.last_name} onChange={(e) => setProfile({ ...profile, last_name: e.target.value })} />
              </Field>
            </div>
            <Field label="Job title">
              <Input value={profile.job_title} onChange={(e) => setProfile({ ...profile, job_title: e.target.value })} placeholder="e.g. Frontend Engineer" />
            </Field>
            <Button type="submit" variant="primary" loading={updateMe.isPending}>Save profile</Button>
          </form>
        </Card>

        <Card icon={<KeyRound className="size-4" />} title="Change password">
          <form onSubmit={savePassword} className="space-y-4">
            <Field label="Current password" error={passwordErrors.current_password}>
              <Input type="password" required autoComplete="current-password" value={passwords.current_password} onChange={(e) => setPasswords({ ...passwords, current_password: e.target.value })} />
            </Field>
            <Field label="New password" error={passwordErrors.new_password} hint="At least 8 characters, not entirely numeric.">
              <Input type="password" required minLength={8} autoComplete="new-password" value={passwords.new_password} onChange={(e) => setPasswords({ ...passwords, new_password: e.target.value })} />
            </Field>
            <Button type="submit" loading={changePassword.isPending}>Update password</Button>
          </form>
        </Card>
      </PageBody>
    </>
  );
}
