import { Copy, LogOut, Mail, Send, Trash, UserPlus, Users } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { PageBody, PageHeader } from "@/components/layout/PageHeader";
import { Button, IconButton } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { Avatar, Badge, EmptyState, Skeleton } from "@/components/ui/Misc";
import { ConfirmDialog, Modal } from "@/components/ui/Modal";
import { Select, type Option } from "@/components/ui/Select";
import {
  useCreateInvitation, useInvitations, useMembers, useRemoveMember, useResendInvitation, useRevokeInvitation,
  useUpdateMember,
} from "@/hooks/queries";
import { usePermissions, useWorkspace } from "@/hooks/useWorkspace";
import { ROLES } from "@/lib/constants";
import { cn, formatDate, getErrorMessage, isPlanLimit, timeAgo } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import type { Invitation, Member, Role } from "@/types";

const assignableRoles: Option<Role>[] = (["admin", "member", "viewer"] as Role[]).map((role) => {
  const Icon = ROLES[role].icon;
  return { value: role, label: ROLES[role].label, icon: <Icon className="size-4 text-slate-400" /> };
});

function RoleBadge({ role }: { role: Role }) {
  const Icon = ROLES[role].icon;
  return (
    <Badge className={cn("ring-1 ring-inset", ROLES[role].badge)}>
      <Icon className="size-3" /> {ROLES[role].label}
    </Badge>
  );
}

function copy(text: string) {
  navigator.clipboard.writeText(text);
  toast.success("Invite link copied", { description: "Share it with your teammate." });
}

export default function MembersPage() {
  const workspace = useWorkspace();
  const { isAdmin } = usePermissions();
  const me = useAuth((s) => s.user);
  const navigate = useNavigate();
  const { data: members = [], isLoading } = useMembers();
  const { data: invitations = [] } = useInvitations(isAdmin);
  const updateMember = useUpdateMember();
  const removeMember = useRemoveMember();
  const revoke = useRevokeInvitation();
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);

  const leaving = removing?.user.id === me?.id;

  return (
    <>
      <PageHeader
        title="Members"
        description={`${members.length} people have access to ${workspace.name}.`}
        actions={isAdmin && <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setInviting(true)}>Invite people</Button>}
      />
      <PageBody className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(Object.keys(ROLES) as Role[]).map((role) => {
            const Icon = ROLES[role].icon;
            return (
              <div key={role} className="card flex gap-3 p-4">
                <Icon className="mt-0.5 size-5 shrink-0 text-slate-400" />
                <div>
                  <p className="text-sm font-semibold">
                    {ROLES[role].label}
                    <span className="ml-1.5 text-slate-400">{members.filter((m) => m.role === role).length}</span>
                  </p>
                  <p className="text-xs text-slate-500">{ROLES[role].description}</p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="card overflow-hidden">
          {isLoading ? (
            <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : members.length === 0 ? (
            <EmptyState icon={<Users className="size-6" />} title="No members" />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {members.map((member) => {
                const isMe = member.user.id === me?.id;
                const editable = isAdmin && !isMe && member.role !== "owner";
                return (
                  <li key={member.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <Avatar user={member.user} size="lg" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">
                        {member.user.display_name}
                        {isMe && <span className="ml-1.5 text-xs font-normal text-slate-400">(you)</span>}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {member.user.email}
                        {member.user.job_title && ` · ${member.user.job_title}`}
                      </p>
                    </div>
                    <span className="hidden text-xs text-slate-400 md:inline">Joined {formatDate(member.joined_at)}</span>
                    {editable ? (
                      <Select
                        className="w-32"
                        size="sm"
                        value={member.role}
                        onChange={(role) =>
                          updateMember.mutate(
                            { id: member.id, role },
                            { onSuccess: () => toast.success(`${member.user.display_name} is now ${ROLES[role].label.toLowerCase()}`) },
                          )
                        }
                        options={assignableRoles}
                      />
                    ) : (
                      <RoleBadge role={member.role} />
                    )}
                    {(editable || (isMe && member.role !== "owner")) && (
                      <IconButton label={isMe ? "Leave workspace" : "Remove member"} onClick={() => setRemoving(member)}>
                        {isMe ? <LogOut className="size-4" /> : <Trash className="size-4" />}
                      </IconButton>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {isAdmin && invitations.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-semibold">Pending invitations</h2>
            <div className="card divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">
              {invitations.map((invite) => (
                <InviteRow key={invite.id} invite={invite} onRevoke={() => revoke.mutate(invite.id, { onSuccess: () => toast.success("Invitation revoked") })} />
              ))}
            </div>
          </section>
        )}
      </PageBody>

      <InviteModal open={inviting} onClose={() => setInviting(false)} />
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={leaving ? `Leave ${workspace.name}?` : `Remove ${removing?.user.display_name}?`}
        description={leaving ? "You'll lose access until someone invites you again." : "They will immediately lose access to this workspace. Their issues stay."}
        confirmLabel={leaving ? "Leave workspace" : "Remove"}
        loading={removeMember.isPending}
        onConfirm={() =>
          removing &&
          removeMember.mutate(removing.id, {
            onSuccess: () => {
              setRemoving(null);
              if (leaving) navigate("/");
              else toast.success("Member removed");
            },
          })
        }
      />
    </>
  );
}

function InviteRow({ invite, onRevoke }: { invite: Invitation; onRevoke: () => void }) {
  const resend = useResendInvitation();
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-3">
      <span className="flex size-10 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800">
        <Mail className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{invite.email}</p>
        <p className="text-xs text-slate-500">
          Invited {timeAgo(invite.created_at)} by {invite.invited_by?.display_name ?? "someone"} · expires {formatDate(invite.expires_at)}
          {" · "}
          {invite.email_sent_at ? `email sent ${timeAgo(invite.email_sent_at)}` : "email not sent yet"}
        </p>
      </div>
      <RoleBadge role={invite.role} />
      <Button
        size="sm"
        variant="ghost"
        icon={<Send className="size-3.5" />}
        loading={resend.isPending}
        onClick={() =>
          resend.mutate(invite.id, {
            onSuccess: ({ queued }) => {
              if (queued) toast.success("Invitation email queued");
              else toast.error("Couldn't queue the email. Copy the link instead.");
            },
          })
        }
      >
        Resend
      </Button>
      <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => copy(invite.accept_url)}>
        Copy link
      </Button>
      <IconButton label="Revoke invitation" onClick={onRevoke}>
        <Trash className="size-4" />
      </IconButton>
    </div>
  );
}

function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateInvitation();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [created, setCreated] = useState<Invitation | null>(null);

  const close = () => {
    onClose();
    setTimeout(() => {
      setEmail("");
      setRole("member");
      setCreated(null);
      create.reset();
    }, 200);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { email, role },
      {
        onSuccess: setCreated,
        // Close the dialog so the toast's "View plans" button can be clicked.
        onError: (error) => {
          if (isPlanLimit(error)) close();
        },
      },
    );
  };

  return (
    <Modal open={open} onClose={close} title="Invite people" description="They'll join with the role you choose. Links expire after 7 days.">
      {created ? (
        <div className="space-y-4">
          <div className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
            We're emailing an invitation to <strong>{created.email}</strong>. You can also share this link with them:
          </div>
          <div className="flex gap-2">
            <Input readOnly value={created.accept_url} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
            <Button icon={<Copy className="size-4" />} onClick={() => copy(created.accept_url)}>Copy</Button>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setCreated(null); setEmail(""); create.reset(); }}>Invite another</Button>
            <Button variant="primary" onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email address" error={create.isError ? getErrorMessage(create.error) : undefined}>
            <Input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" />
          </Field>
          <Field label="Role" hint={ROLES[role].description}>
            <Select value={role} onChange={setRole} options={assignableRoles} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={create.isPending}>Send invitation</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
