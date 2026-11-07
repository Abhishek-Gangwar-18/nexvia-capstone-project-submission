import { Building } from "lucide-react";
import { useEffect } from "react";
import { Link, Navigate, Outlet, useParams } from "react-router";
import { CreateIssueModal } from "@/components/issues/CreateIssueModal";
import { IssueDrawer } from "@/components/issues/IssueDrawer";
import { Button } from "@/components/ui/Button";
import { EmptyState, PageLoader } from "@/components/ui/Misc";
import { useMe, useWorkspaces } from "@/hooks/queries";
import { WorkspaceContext } from "@/hooks/useWorkspace";
import { useAuth } from "@/store/auth";
import { useUI } from "@/store/ui";
import { CommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

/** Requires a logged-in user; bounces to /login and remembers where they were going. */
export function RequireAuth() {
  const access = useAuth((s) => s.access);
  useMe();
  if (!access) {
    // Logging out already navigates to /login; this tree can render once more before it unmounts.
    if (window.location.pathname === "/login") return null;
    const next = window.location.pathname + window.location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <Outlet />;
}

/** "/" → the last workspace you used, else your first, else onboarding. */
export function HomeRedirect() {
  const { data: workspaces, isLoading } = useWorkspaces();
  const last = useUI((s) => s.lastWorkspace);
  if (isLoading || !workspaces) return <PageLoader />;
  if (workspaces.length === 0) return <Navigate to="/onboarding" replace />;
  const target = workspaces.find((w) => w.slug === last) ?? workspaces[0];
  return <Navigate to={`/w/${target.slug}/dashboard`} replace />;
}

function useGlobalHotkeys() {
  const openCreate = useUI((s) => s.openCreateIssue);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "c") {
        e.preventDefault();
        openCreate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openCreate]);
}

export function WorkspaceLayout() {
  const { slug } = useParams();
  const { data: workspaces, isLoading } = useWorkspaces();
  const setLastWorkspace = useUI((s) => s.setLastWorkspace);
  const workspace = workspaces?.find((w) => w.slug === slug);

  useEffect(() => {
    if (workspace) {
      setLastWorkspace(workspace.slug);
      document.title = `${workspace.name} · FlowBoard`;
    }
  }, [workspace, setLastWorkspace]);

  if (isLoading) return <PageLoader />;
  if (!workspace) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <EmptyState
          icon={<Building className="size-6" />}
          title="Workspace not found"
          description="It doesn't exist or you're not a member. Ask an admin for an invitation."
          action={<Link to="/"><Button variant="primary">Go to my workspaces</Button></Link>}
        />
      </div>
    );
  }

  return (
    <WorkspaceContext.Provider value={workspace}>
      <WorkspaceShell />
    </WorkspaceContext.Provider>
  );
}

function WorkspaceShell() {
  useGlobalHotkeys();
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </main>
      </div>
      <IssueDrawer />
      <CreateIssueModal />
      <CommandPalette />
    </div>
  );
}
