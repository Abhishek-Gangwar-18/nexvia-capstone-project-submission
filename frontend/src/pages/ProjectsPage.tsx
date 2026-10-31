import { Archive, FolderKanban, Plus, Search } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { PageBody, PageHeader } from "@/components/layout/PageHeader";
import { ProjectFormModal } from "@/components/ProjectFormModal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Avatar, EmptyState, ProgressBar, Skeleton } from "@/components/ui/Misc";
import { useProjects } from "@/hooks/queries";
import { usePermissions, useWorkspace } from "@/hooks/useWorkspace";
import { cn, percent, pluralize } from "@/lib/utils";

export default function ProjectsPage() {
  const workspace = useWorkspace();
  const { isAdmin } = usePermissions();
  const { data: projects = [], isLoading } = useProjects();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const visible = projects.filter(
    (p) => p.is_archived === showArchived && `${p.name} ${p.key}`.toLowerCase().includes(query.toLowerCase()),
  );
  const archivedCount = projects.filter((p) => p.is_archived).length;

  return (
    <>
      <PageHeader
        title="Projects"
        description={`${pluralize(projects.length - archivedCount, "active project")} in ${workspace.name}`}
        actions={
          isAdmin && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New project
            </Button>
          )
        }
      />
      <PageBody>
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter projects…" className="pl-9" />
          </div>
          {archivedCount > 0 && (
            <Button
              variant={showArchived ? "subtle" : "ghost"}
              size="sm"
              icon={<Archive className="size-4" />}
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? "Showing archived" : `Archived (${archivedCount})`}
            </Button>
          )}
        </div>

        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-48" />)}
          </div>
        ) : visible.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<FolderKanban className="size-6" />}
              title={query ? "No matching projects" : showArchived ? "No archived projects" : "No projects yet"}
              description={isAdmin ? "Create a project to get a board, backlog and workflow." : "Ask an admin to create a project."}
              action={isAdmin && !query && !showArchived && (
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Create project</Button>
              )}
            />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((project, index) => {
              const progress = percent(project.done_count, project.issue_count);
              return (
                <Link
                  key={project.id}
                  to={`/w/${workspace.slug}/projects/${project.key}/board`}
                  style={{ animationDelay: `${index * 50}ms` }}
                  className={cn(
                    "card group animate-slide-up relative overflow-hidden p-5 transition duration-200 hover:-translate-y-1 hover:shadow-lg hover:shadow-slate-900/5",
                    project.is_archived && "opacity-70",
                  )}
                >
                  <div className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: project.color }} />
                  <div className="flex items-start gap-3">
                    <span
                      className="flex size-11 shrink-0 items-center justify-center rounded-xl text-base font-bold text-white shadow-sm"
                      style={{ backgroundColor: project.color }}
                    >
                      {project.key.slice(0, 2)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-semibold group-hover:text-brand-600 dark:group-hover:text-brand-400">{project.name}</h3>
                      <p className="text-xs text-slate-500">
                        <span className="font-mono">{project.key}</span> · {project.board?.board_type === "kanban" ? "Kanban" : "Scrum"}
                      </p>
                    </div>
                    {project.lead_detail && <Avatar user={project.lead_detail} size="md" />}
                  </div>
                  <p className="mt-3 line-clamp-2 min-h-10 text-sm text-slate-500 dark:text-slate-400">
                    {project.description || "No description."}
                  </p>
                  <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
                    <span>{pluralize(project.issue_count, "issue")}</span>
                    <span>{progress}% done</span>
                  </div>
                  <ProgressBar className="mt-1.5" value={progress} />
                  {project.active_sprint && (
                    <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                      <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                      {project.active_sprint.name}
                    </p>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </PageBody>
      <ProjectFormModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
