import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, ListChecks, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router";
import { PageBody, PageHeader } from "@/components/layout/PageHeader";
import { LabelChips, PointsBadge, PriorityIcon, StatusBadge, TypeIcon, useIssueDrawer } from "@/components/issues/IssueMeta";
import { priorityOptions, typeOptions } from "@/components/issues/options";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Avatar, EmptyState, Skeleton } from "@/components/ui/Misc";
import { Select, type Option } from "@/components/ui/Select";
import { useIssuesPage, useLabels, useMembers, useProjects, type IssueParams } from "@/hooks/queries";
import { usePermissions } from "@/hooks/useWorkspace";
import { CATEGORIES } from "@/lib/constants";
import { cn, timeAgo } from "@/lib/utils";
import { useUI } from "@/store/ui";
import type { IssueType, Priority, Project, StatusCategory } from "@/types";

const PAGE_SIZE = 25;

const columns: { key: string; label: string; sort?: string; className?: string }[] = [
  { key: "key", label: "Key", sort: "number", className: "w-24" },
  { key: "title", label: "Summary" },
  { key: "status", label: "Status", className: "w-36" },
  { key: "priority", label: "Priority", sort: "priority", className: "w-24" },
  { key: "assignee", label: "Assignee", className: "w-44" },
  { key: "points", label: "Pts", sort: "story_points", className: "w-14 text-center" },
  { key: "updated", label: "Updated", sort: "updated_at", className: "w-28" },
];

function useDebounced<T>(value: T, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/** Works both workspace-wide (/issues) and inside a project (/projects/:key/issues). */
export default function IssuesPage() {
  const scopedProject = useOutletContext<Project | undefined>();
  const { canEdit } = usePermissions();
  const openCreate = useUI((s) => s.openCreateIssue);
  const drawer = useIssueDrawer();
  const projects = useProjects().data ?? [];
  const members = useMembers().data ?? [];
  const labelList = useLabels().data ?? [];
  const labels = useMemo(() => new Map(labelList.map((l) => [l.id, l])), [labelList]);
  const statusById = useMemo(
    () => new Map(projects.flatMap((p) => p.statuses.map((s) => [s.id, s] as const))),
    [projects],
  );

  const [search, setSearch] = useState("");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [category, setCategory] = useState<StatusCategory | null>(null);
  const [type, setType] = useState<IssueType | null>(null);
  const [priority, setPriority] = useState<Priority | null>(null);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [ordering, setOrdering] = useState("-updated_at");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounced(search);

  const params: IssueParams = {
    project: scopedProject?.id ?? projectId ?? undefined,
    search: debouncedSearch,
    status_category: category ?? undefined,
    issue_type: type ?? undefined,
    priority: priority?.toString(),
    assignee: assignee ?? undefined,
    ordering,
    page,
    page_size: PAGE_SIZE,
  };
  useEffect(() => setPage(1), [debouncedSearch, projectId, category, type, priority, assignee, ordering]);

  const { data, isLoading, isFetching } = useIssuesPage(params);
  const issues = data?.results ?? [];
  const total = data?.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const assigneeOptions: Option<string | null>[] = [
    { value: null, label: "Any assignee" },
    { value: "me", label: "Assigned to me" },
    { value: "none", label: "Unassigned" },
    ...members.map((m) => ({ value: String(m.user.id), label: m.user.display_name, icon: <Avatar user={m.user} size="xs" /> })),
  ];

  const toggleSort = (field: string) =>
    setOrdering((current) => (current === field ? `-${field}` : current === `-${field}` ? field : `-${field}`));

  const sortIcon = (field?: string) => {
    if (!field) return null;
    if (ordering === field) return <ArrowUp className="size-3.5" />;
    if (ordering === `-${field}`) return <ArrowDown className="size-3.5" />;
    return <ArrowUpDown className="size-3.5 opacity-0 group-hover:opacity-50" />;
  };

  const body = (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search key, title, description…" className="pl-9" />
        </div>
        {!scopedProject && (
          <Select
            className="w-44"
            value={projectId}
            onChange={setProjectId}
            options={[{ value: null, label: "All projects" }, ...projects.map((p) => ({ value: p.id as number | null, label: p.name, hint: p.key }))]}
          />
        )}
        <Select
          className="w-36"
          value={category}
          onChange={setCategory}
          options={[
            { value: null, label: "Any status" },
            ...(Object.keys(CATEGORIES) as StatusCategory[]).map((c) => ({ value: c as StatusCategory | null, label: CATEGORIES[c].label })),
          ]}
        />
        <Select className="w-36" value={type} onChange={setType} options={[{ value: null, label: "Any type" }, ...typeOptions()]} />
        <Select className="w-36" value={priority} onChange={setPriority} options={[{ value: null, label: "Any priority" }, ...priorityOptions]} />
        <Select className="w-44" value={assignee} onChange={setAssignee} options={assigneeOptions} />
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:bg-slate-800/40">
                {columns.map((col) => (
                  <th key={col.key} className={cn("px-4 py-2.5", col.className)}>
                    {col.sort ? (
                      <button onClick={() => toggleSort(col.sort!)} className="group inline-flex cursor-pointer items-center gap-1 uppercase hover:text-slate-800 dark:hover:text-slate-200">
                        {col.label} {sortIcon(col.sort)}
                      </button>
                    ) : (
                      col.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={cn("divide-y divide-slate-100 transition-opacity dark:divide-slate-800", isFetching && !isLoading && "opacity-60")}>
              {isLoading &&
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={columns.length} className="px-4 py-2.5"><Skeleton className="h-5" /></td>
                  </tr>
                ))}
              {issues.map((issue) => (
                <tr key={issue.id} onClick={() => drawer.open(issue.key)} className="cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2">
                      <TypeIcon type={issue.issue_type} />
                      <span className="font-semibold whitespace-nowrap text-slate-500">{issue.key}</span>
                    </span>
                  </td>
                  <td className="max-w-0 px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className={cn("truncate font-medium", issue.status_category === "done" && "text-slate-400 line-through")}>{issue.title}</span>
                      <span className="hidden shrink-0 xl:inline-flex">
                        <LabelChips ids={issue.labels} labels={labels} max={2} />
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge category={issue.status_category} status={statusById.get(issue.status)} />
                  </td>
                  <td className="px-4 py-2.5"><PriorityIcon priority={issue.priority} /></td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2">
                      <Avatar user={issue.assignee_detail} size="sm" />
                      <span className="truncate text-slate-600 dark:text-slate-400">{issue.assignee_detail?.display_name ?? "Unassigned"}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-center"><PointsBadge points={issue.story_points} /></td>
                  <td className="px-4 py-2.5 text-xs whitespace-nowrap text-slate-500">{timeAgo(issue.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!isLoading && issues.length === 0 && (
          <EmptyState
            icon={<ListChecks className="size-6" />}
            title="No issues match"
            description="Try clearing a filter, or create a new issue."
            action={canEdit && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => openCreate({ projectId: scopedProject?.id })}>Create issue</Button>}
          />
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
    </>
  );

  if (scopedProject) return <PageBody className="pt-5">{body}</PageBody>;
  return (
    <>
      <PageHeader
        title="All issues"
        description="Every issue across the projects in this workspace."
        actions={canEdit && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => openCreate()}>Create issue</Button>}
      />
      <PageBody>{body}</PageBody>
    </>
  );
}
