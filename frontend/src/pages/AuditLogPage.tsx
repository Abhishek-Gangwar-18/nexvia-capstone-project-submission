import { ChevronLeft, ChevronRight, History, Search, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { PageBody, PageHeader } from "@/components/layout/PageHeader";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Avatar, EmptyState, Skeleton } from "@/components/ui/Misc";
import { Select, type Option } from "@/components/ui/Select";
import { useAuditLog, useMembers, useProjects } from "@/hooks/queries";
import { usePermissions } from "@/hooks/useWorkspace";
import { cn, formatDate, timeAgo } from "@/lib/utils";
import type { AuditEntry } from "@/types";

const PAGE_SIZE = 30;

const ACTIONS: Record<string, string> = {
  created: "created", updated: "updated", moved: "moved", commented: "commented on", attached: "added a file to",
  detached: "removed a file from", deleted: "deleted", archived: "archived", restored: "restored", started: "started",
  completed: "completed", invited: "invited", revoked: "revoked the invitation for", joined: "joined as",
  left: "left as", removed: "removed", role_changed: "changed the role of", secret_rotated: "rotated the secret of",
};

const ENTITIES = ["issue", "project", "sprint", "workflow", "board", "member", "invitation", "workspace", "label", "webhook"];
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).replaceAll("_", " ");

const entityOptions: Option<string | null>[] = [
  { value: null, label: "Everything" },
  ...ENTITIES.map((e) => ({ value: e as string | null, label: capitalize(e) })),
];
const actionOptions: Option<string | null>[] = [
  { value: null, label: "Any action" },
  ...Object.keys(ACTIONS).map((a) => ({ value: a as string | null, label: capitalize(a) })),
];

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ") || "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).length > 80 ? `${String(value).slice(0, 80)}…` : String(value);
}

/** Turns the stored JSON into readable "field: old → new" fragments. */
function describeChanges(changes: Record<string, unknown>) {
  return Object.entries(changes)
    .filter(([key]) => !["comment_id", "attachment_id", "edited", "deleted", "new_mentions"].includes(key))
    .map(([key, value]) => {
      const label = key.replaceAll("_", " ");
      if (value && typeof value === "object" && !Array.isArray(value) && ("from" in value || "to" in value)) {
        const diff = value as { from?: unknown; to?: unknown };
        return "from" in diff ? `${label}: ${display(diff.from)} → ${display(diff.to)}` : `${label}: ${display(diff.to)}`;
      }
      return `${label}: ${display(value)}`;
    });
}

function sentence(entry: AuditEntry) {
  if (entry.action === "joined" || entry.action === "left") {
    const role = entry.changes.role;
    return `${ACTIONS[entry.action]} ${typeof role === "string" ? role : "member"}`;
  }
  const noun = ["member", "invitation"].includes(entry.entity_type) ? "" : `${entry.entity_type} `;
  return `${ACTIONS[entry.action] ?? entry.action} ${noun}`;
}

export default function AuditLogPage() {
  const { isAdmin } = usePermissions();
  if (!isAdmin) {
    return (
      <EmptyState
        className="flex-1"
        icon={<ShieldAlert className="size-6" />}
        title="Admins only"
        description="Ask a workspace admin if you need to know who changed something."
      />
    );
  }
  return <AuditLogContent />;
}

function AuditLogContent() {
  const members = useMembers().data ?? [];
  const projects = useProjects().data ?? [];
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [entity, setEntity] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [actor, setActor] = useState<number | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => setPage(1), [debounced, entity, action, actor, project, dateFrom, dateTo]);

  const { data, isLoading, isFetching } = useAuditLog({
    search: debounced || undefined,
    entity_type: entity ?? undefined,
    action: action ?? undefined,
    actor: actor ?? undefined,
    project: project ?? undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    page,
    page_size: PAGE_SIZE,
  });
  const entries = data?.results ?? [];
  const total = data?.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = !!(search || entity || action || actor || project || dateFrom || dateTo);

  const clear = () => {
    setSearch("");
    setEntity(null);
    setAction(null);
    setActor(null);
    setProject(null);
    setDateFrom("");
    setDateTo("");
  };

  return (
    <>
      <PageHeader title="Audit log" description="Who changed what across this workspace. Entries can't be edited or deleted." />
      <PageBody>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or key" className="pl-9" />
          </div>
          <Select className="w-36" value={entity} onChange={setEntity} options={entityOptions} />
          <Select className="w-40" value={action} onChange={setAction} options={actionOptions} />
          <Select
            className="w-44"
            value={actor}
            onChange={setActor}
            options={[
              { value: null, label: "Anyone" },
              ...members.map((m) => ({ value: m.user.id as number | null, label: m.user.display_name, icon: <Avatar user={m.user} size="xs" /> })),
            ]}
          />
          <Select
            className="w-40"
            value={project}
            onChange={setProject}
            options={[
              { value: null, label: "All projects" },
              ...projects.map((p) => ({ value: p.key as string | null, label: p.name, hint: p.key })),
            ]}
          />
          <div className="w-38">
            <Input aria-label="From date" type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div className="w-38">
            <Input aria-label="To date" type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          {filtered && (
            <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={clear}>
              Clear
            </Button>
          )}
        </div>

        <div className="card overflow-hidden">
          {isLoading ? (
            <div className="space-y-3 p-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : entries.length === 0 ? (
            <EmptyState
              icon={<History className="size-6" />}
              title={filtered ? "Nothing matches these filters" : "No activity yet"}
              description={filtered ? "Try widening the filters." : "Changes in this workspace will show up here."}
            />
          ) : (
            <ul className={cn("divide-y divide-slate-100 transition-opacity dark:divide-slate-800", isFetching && "opacity-60")}>
              {entries.map((entry) => <AuditRow key={entry.id} entry={entry} />)}
            </ul>
          )}
          {total > 0 && (
            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-sm text-slate-500 dark:border-slate-800">
              <span>
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex items-center gap-1">
                <IconButton label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="size-4" />
                </IconButton>
                <span className="px-2 text-xs">Page {page} / {pages}</span>
                <IconButton label="Next page" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                  <ChevronRight className="size-4" />
                </IconButton>
              </div>
            </div>
          )}
        </div>
      </PageBody>
    </>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const details = describeChanges(entry.changes);
  const selfDescribing = entry.action === "joined" || entry.action === "left";
  return (
    <li className="flex gap-3 px-5 py-3">
      <Avatar user={entry.actor} size="md" />
      <div className="min-w-0 flex-1">
        <p className="text-sm break-words">
          <strong className="font-semibold">{entry.actor?.display_name ?? "Former member"}</strong>{" "}
          <span className="text-slate-600 dark:text-slate-400">{sentence(entry)}</span>
          {!selfDescribing && <strong className="font-medium">{entry.entity_label}</strong>}
        </p>
        {details.length > 0 && !selfDescribing && (
          <p className="mt-0.5 text-xs break-words text-slate-500">{details.join(" · ")}</p>
        )}
      </div>
      <div className="shrink-0 text-right text-xs text-slate-500" title={formatDate(entry.created_at, "PPpp")}>
        <p>{timeAgo(entry.created_at)}</p>
        {entry.project_key && <p className="mt-0.5 font-mono text-[11px] text-slate-400">{entry.project_key}</p>}
      </div>
    </li>
  );
}
