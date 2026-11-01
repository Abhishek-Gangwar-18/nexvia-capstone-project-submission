import { Archive, ArchiveArrowUp, Ellipsis, FolderKanban, GitBranch, List, ListTodo, Plus, Settings, SquareKanban, Trash } from "lucide-react";
import { useState } from "react";
import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { ProjectFormModal } from "@/components/ProjectFormModal";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { EmptyState, PageLoader } from "@/components/ui/Misc";
import { ConfirmDialog } from "@/components/ui/Modal";
import { useDeleteProject, useProject, useUpdateProject } from "@/hooks/queries";
import { usePermissions, useWorkspace } from "@/hooks/useWorkspace";
import { cn } from "@/lib/utils";
import { useUI } from "@/store/ui";

export default function ProjectLayout() {
  const { key = "" } = useParams();
  const workspace = useWorkspace();
  const { canEdit, isAdmin } = usePermissions();
  const { data: project, isLoading, isError } = useProject(key);
  const update = useUpdateProject(key);
  const remove = useDeleteProject();
  const navigate = useNavigate();
  const openCreate = useUI((s) => s.openCreateIssue);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  if (isLoading) return <PageLoader />;
  if (isError || !project) {
    return (
      <EmptyState
        className="flex-1"
        icon={<FolderKanban className="size-6" />}
        title="Project not found"
        description="It may have been deleted, or the key is wrong."
        action={<Link to={`/w/${workspace.slug}/projects`}><Button variant="primary">All projects</Button></Link>}
      />
    );
  }

  const base = `/w/${workspace.slug}/projects/${project.key}`;
  const tabs = [
    { to: `${base}/board`, label: "Board", icon: SquareKanban },
    ...(project.board?.board_type === "scrum" ? [{ to: `${base}/backlog`, label: "Backlog", icon: ListTodo }] : []),
    { to: `${base}/issues`, label: "Issues", icon: List },
    { to: `${base}/workflow`, label: "Workflow", icon: GitBranch },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-slate-200/80 bg-white px-4 pt-5 sm:px-8 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white shadow-sm"
            style={{ backgroundColor: project.color }}
          >
            {project.key.slice(0, 2)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-slate-500">
              <Link to={`/w/${workspace.slug}/projects`} className="hover:text-brand-600">Projects</Link> / {project.key}
            </p>
            <h1 className="flex items-center gap-2 truncate text-lg font-bold tracking-tight">
              {project.name}
              {project.is_archived && (
                <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 uppercase dark:bg-slate-800">Archived</span>
              )}
            </h1>
          </div>
          {canEdit && !project.is_archived && (
            <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => openCreate({ projectId: project.id })}>
              Issue
            </Button>
          )}
          {isAdmin && (
            <Dropdown
              trigger={<IconButton label="Project actions"><Ellipsis className="size-4" /></IconButton>}
              items={[
                { label: "Project settings", icon: <Settings className="size-4" />, onClick: () => setEditing(true) },
                {
                  label: project.is_archived ? "Restore project" : "Archive project",
                  icon: project.is_archived ? <ArchiveArrowUp className="size-4" /> : <Archive className="size-4" />,
                  onClick: () =>
                    update.mutate(
                      { is_archived: !project.is_archived },
                      { onSuccess: () => toast.success(project.is_archived ? "Project restored" : "Project archived") },
                    ),
                },
                { separator: true, label: "" },
                { label: "Delete project", icon: <Trash className="size-4" />, danger: true, onClick: () => setDeleting(true) },
              ]}
            />
          )}
        </div>
        <nav className="-mb-px mt-4 flex gap-1 overflow-x-auto">
          {tabs.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-1.5 border-b-2 px-3 pb-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-300"
                    : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:hover:text-slate-200",
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
      </div>

      <Outlet context={project} />

      <ProjectFormModal open={editing} onClose={() => setEditing(false)} project={project} />
      <ConfirmDialog
        open={deleting}
        onClose={() => {
          setDeleting(false);
          setConfirmText("");
        }}
        title={`Delete ${project.name}?`}
        description="All issues, sprints and the board in this project will be permanently deleted."
        confirmLabel="Delete project"
        loading={remove.isPending}
        onConfirm={() => {
          if (confirmText !== project.key) {
            toast.error(`Type ${project.key} to confirm`);
            return;
          }
          remove.mutate(project.key, {
            onSuccess: () => {
              toast.success("Project deleted");
              navigate(`/w/${workspace.slug}/projects`);
            },
          });
        }}
      >
        <label className="block text-sm text-slate-600 dark:text-slate-400">
          Type <strong className="font-mono">{project.key}</strong> to confirm.
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
            className={cn(
              "mt-2 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 font-mono text-sm uppercase dark:border-slate-700 dark:bg-slate-900",
            )}
          />
        </label>
      </ConfirmDialog>
    </div>
  );
}
