import {
  AtSign,
  Clock3,
  Download,
  FileText,
  History,
  MessageSquare,
  Paperclip,
  Send,
  Trash,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import { Button, IconButton } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import {
  useCreateIssueComment,
  useDeleteIssueAttachment,
  useDeleteIssueComment,
  useDownloadIssueAttachment,
  useEditIssueComment,
  useIssueActivity,
  useIssueAttachments,
  useIssueComments,
  useUploadIssueAttachment,
} from "@/hooks/queries";
import { usePermissions } from "@/hooks/useWorkspace";
import { formatDate, timeAgo } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import type { IssueActivity, IssueAttachment, IssueComment, UserMini } from "@/types";
import { Avatar } from "../ui/Misc";
import { ConfirmDialog } from "../ui/Modal";

type Tab = "comments" | "files" | "activity";

export function IssueCollaboration({ issueKey, members }: { issueKey: string; members: UserMini[] }) {
  const [tab, setTab] = useState<Tab>("comments");
  const tabs = [
    { id: "comments" as const, label: "Comments", icon: MessageSquare },
    { id: "files" as const, label: "Files", icon: Paperclip },
    { id: "activity" as const, label: "Activity", icon: History },
  ];
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
      <nav
        className="flex gap-1 border-b border-slate-200 px-2 pt-2 dark:border-slate-800"
        aria-label="Issue collaboration"
      >
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium ${tab === id ? "border-brand-600 text-brand-700 dark:text-brand-300" : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"}`}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </nav>
      <div className="p-4">
        {tab === "comments" && <Comments issueKey={issueKey} members={members} />}
        {tab === "files" && <Files issueKey={issueKey} />}
        {tab === "activity" && <Activity issueKey={issueKey} />}
      </div>
    </section>
  );
}

function Comments({ issueKey, members }: { issueKey: string; members: UserMini[] }) {
  const [draft, setDraft] = useState("");
  const { canEdit, isAdmin } = usePermissions();
  const user = useAuth((s) => s.user);
  const comments = useIssueComments(issueKey);
  const create = useCreateIssueComment(issueKey);
  const edit = useEditIssueComment(issueKey);
  const remove = useDeleteIssueComment(issueKey);
  const mention = (member: UserMini) =>
    setDraft((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}@${member.email} `);
  const submit = () => {
    const body = draft.trim();
    if (!body) return;
    create.mutate({ body }, { onSuccess: () => setDraft("") });
  };
  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="space-y-2">
          <Textarea
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Write a comment… Use @email to mention a teammate."
            maxLength={10000}
          />
          <div className="flex items-center justify-between">
            <div className="flex max-w-[70%] items-center gap-1 overflow-x-auto">
              <AtSign className="size-3.5 shrink-0 text-slate-400" />
              {members
                .filter((member) => member.id !== user?.id)
                .map((member) => (
                  <button
                    key={member.id}
                    onClick={() => mention(member)}
                    className="shrink-0 cursor-pointer rounded-md bg-slate-100 px-1.5 py-1 text-[10px] text-slate-600 hover:bg-brand-50 hover:text-brand-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-brand-500/10"
                    title={`Mention ${member.email}`}
                  >
                    {member.display_name}
                  </button>
                ))}
            </div>
            <Button
              size="sm"
              variant="primary"
              icon={<Send className="size-3.5" />}
              loading={create.isPending}
              disabled={!draft.trim()}
              onClick={submit}
            >
              Comment
            </Button>
          </div>
        </div>
      )}
      {comments.isLoading ? <p className="text-xs text-slate-400">Loading comments…</p> : null}
      {(comments.data ?? []).length === 0 && !comments.isLoading && (
        <p className="py-3 text-center text-xs text-slate-400">No comments yet.</p>
      )}
      <div className="space-y-4">
        {(comments.data ?? []).map((comment) => (
          <CommentRow
            key={comment.id}
            comment={comment}
            canEdit={canEdit && (isAdmin || comment.author?.id === user?.id)}
            onSave={(body) => edit.mutate({ id: comment.id, body })}
            onDelete={() => remove.mutate(comment.id)}
          />
        ))}
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  canEdit,
  onSave,
  onDelete,
}: {
  comment: IssueComment;
  canEdit: boolean;
  onSave: (body: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  return (
    <article className="flex gap-2.5">
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Delete this comment?"
        description="This can't be undone."
        onConfirm={() => {
          setConfirming(false);
          onDelete();
        }}
      />
      <Avatar user={comment.author} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold">{comment.author?.display_name ?? "Former member"}</span>
          <span className="text-[10px] text-slate-400" title={formatDate(comment.created_at)}>
            {timeAgo(comment.created_at)}
          </span>
          {canEdit && (
            <span className="ml-auto flex gap-1">
              <button className="text-[10px] text-slate-400 hover:text-brand-600" onClick={() => setEditing((v) => !v)}>
                {editing ? "Cancel" : "Edit"}
              </button>
              <button className="text-[10px] text-slate-400 hover:text-rose-600" onClick={() => setConfirming(true)}>
                Delete
              </button>
            </span>
          )}
        </div>
        {editing ? (
          <div className="mt-2 space-y-2">
            <Textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <Button
              size="xs"
              variant="primary"
              onClick={() => {
                onSave(draft);
                setEditing(false);
              }}
            >
              Save
            </Button>
          </div>
        ) : (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700 dark:text-slate-300">
            {comment.body}
          </p>
        )}
        {comment.mentions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {comment.mentions.map((member) => (
              <span
                key={member.id}
                className="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
              >
                @{member.display_name}
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function Files({ issueKey }: { issueKey: string }) {
  const input = useRef<HTMLInputElement>(null);
  const { canEdit, isAdmin } = usePermissions();
  const user = useAuth((s) => s.user);
  const files = useIssueAttachments(issueKey);
  const upload = useUploadIssueAttachment(issueKey);
  const remove = useDeleteIssueAttachment(issueKey);
  const download = useDownloadIssueAttachment();
  const onFile = (file?: File) => {
    if (!file) return;
    upload.mutate(file, { onSuccess: () => toast.success("File uploaded") });
    if (input.current) input.current.value = "";
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">PDF, images, text, CSV or ZIP · max 25 MB</p>
        {canEdit && (
          <>
            <input
              ref={input}
              type="file"
              className="hidden"
              accept=".csv,.gif,.jpeg,.jpg,.md,.pdf,.png,.txt,.webp,.zip"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            <Button
              size="xs"
              loading={upload.isPending}
              icon={<Upload className="size-3.5" />}
              onClick={() => input.current?.click()}
            >
              Upload
            </Button>
          </>
        )}
      </div>
      {files.isLoading && <p className="text-xs text-slate-400">Loading files…</p>}
      {(files.data ?? []).length === 0 && !files.isLoading && (
        <p className="py-4 text-center text-xs text-slate-400">No files attached.</p>
      )}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {(files.data ?? []).map((file) => (
          <FileRow
            key={file.id}
            file={file}
            canRemove={canEdit && (isAdmin || file.uploaded_by?.id === user?.id)}
            onDownload={() => download.mutate(file)}
            onDelete={() => remove.mutate(file.id, { onSuccess: () => toast.success("Attachment removed") })}
          />
        ))}
      </ul>
    </div>
  );
}

function FileRow({
  file,
  canRemove,
  onDownload,
  onDelete,
}: {
  file: IssueAttachment;
  canRemove: boolean;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex items-center gap-2 py-2">
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Delete ${file.original_name}?`}
        description="The file will be permanently removed."
        onConfirm={() => {
          setConfirming(false);
          onDelete();
        }}
      />
      <FileText className="size-4 shrink-0 text-brand-500" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{file.original_name}</p>
        <p className="text-[10px] text-slate-400">
          {formatSize(file.size)} · {file.uploaded_by?.display_name ?? "Former member"}
        </p>
      </div>
      <IconButton label="Download attachment" onClick={onDownload}>
        <Download className="size-4" />
      </IconButton>
      {canRemove && (
        <IconButton label="Delete attachment" onClick={() => setConfirming(true)}>
          <Trash className="size-4 text-rose-500" />
        </IconButton>
      )}
    </li>
  );
}

function Activity({ issueKey }: { issueKey: string }) {
  const activity = useIssueActivity(issueKey);
  return (
    <div className="space-y-3">
      {activity.isLoading && <p className="text-xs text-slate-400">Loading activity…</p>}
      {(activity.data ?? []).length === 0 && !activity.isLoading && (
        <p className="py-4 text-center text-xs text-slate-400">No activity yet.</p>
      )}
      {(activity.data ?? []).map((event) => (
        <ActivityRow key={event.id} event={event} />
      ))}
    </div>
  );
}

function ActivityRow({ event }: { event: IssueActivity }) {
  const message: Record<IssueActivity["action"], string> = {
    created: "created this issue",
    updated: "updated this issue",
    moved: "moved this issue",
    commented: event.changes.deleted ? "deleted a comment" : event.changes.edited ? "edited a comment" : "commented",
    attached: "added an attachment",
    detached: "removed an attachment",
    deleted: "deleted this issue",
  };
  const attachmentName = typeof event.changes.name === "string" ? event.changes.name : null;
  const changed = Object.entries(event.changes)
    .filter(([, value]) => value && typeof value === "object" && ("from" in value || "to" in value))
    .map(([field, value]) => {
      const diff = value as { from?: unknown; to?: unknown };
      return `${field.replaceAll("_", " ")}: ${String(diff.from ?? "—")} → ${String(diff.to ?? "—")}`;
    });
  return (
    <div className="flex gap-2.5">
      <Avatar user={event.actor} size="xs" />
      <div className="min-w-0 flex-1">
        <p className="text-xs">
          <strong>{event.actor?.display_name ?? "Former member"}</strong> {message[event.action]}
          {attachmentName && <span className="ml-1 font-medium">{attachmentName}</span>}
          <span className="ml-1 text-[10px] text-slate-400" title={format(event.created_at, "PPpp")}>
            {timeAgo(event.created_at)}
          </span>
        </p>
        {changed.length > 0 && <p className="mt-0.5 break-words text-[10px] text-slate-500">{changed.join(" · ")}</p>}
      </div>
      <Clock3 className="size-3.5 shrink-0 text-slate-300" />
    </div>
  );
}

function formatSize(size: number) {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}
