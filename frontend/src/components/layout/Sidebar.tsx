import {
  ChartColumn, Check, ChevronsUpDown, CreditCard, FolderKanban, History, LayoutDashboard, ListTodo, PanelLeftClose, PanelLeftOpen, Plus, Settings,
  SquareKanban, Users, List,
} from "lucide-react";
import { useState } from "react";
import { NavLink, useMatch, useNavigate } from "react-router";
import { Dropdown } from "@/components/ui/Dropdown";
import { Logo } from "@/components/ui/Misc";
import { useProjects, useWorkspaces } from "@/hooks/queries";
import { usePermissions, useWorkspace } from "@/hooks/useWorkspace";
import { PLANS, ROLES } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useUI } from "@/store/ui";
import { CreateWorkspaceModal } from "./CreateWorkspaceModal";

function WorkspaceAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-violet-500 text-sm font-bold text-white shadow-sm",
        className,
      )}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const workspace = useWorkspace();
  const { data: workspaces = [] } = useWorkspaces();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <Dropdown
        anchor="bottom start"
        className="w-full"
        header={<p className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Workspaces</p>}
        trigger={
          <button
            className={cn(
              "flex w-full cursor-pointer items-center gap-2.5 rounded-xl p-1.5 text-left transition hover:bg-slate-100 dark:hover:bg-slate-800",
              collapsed && "justify-center",
            )}
          >
            <WorkspaceAvatar name={workspace.name} />
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{workspace.name}</span>
                  <span className="block text-[11px] text-slate-500">
                    {PLANS[workspace.plan].label} plan · {ROLES[workspace.role].label}
                  </span>
                </span>
                <ChevronsUpDown className="size-4 text-slate-400" />
              </>
            )}
          </button>
        }
        items={[
          ...workspaces.map((ws) => ({
            label: (
              <span className="flex items-center gap-2">
                <WorkspaceAvatar name={ws.name} className="size-6 rounded-md text-xs" />
                <span className="truncate">{ws.name}</span>
              </span>
            ),
            hint: ws.slug === workspace.slug ? <Check className="size-4 text-brand-600" /> : ROLES[ws.role].label,
            onClick: () => navigate(`/w/${ws.slug}/dashboard`),
          })),
          { separator: true, label: "" },
          { label: "Create workspace", icon: <Plus className="size-4" />, onClick: () => setCreating(true) },
        ]}
      />
      <CreateWorkspaceModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function NavItem({
  to, icon: Icon, label, collapsed, end,
}: {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  collapsed: boolean;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        cn(
          "group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors",
          collapsed && "justify-center px-0",
          isActive
            ? "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
            : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100",
        )
      }
    >
      <Icon className="size-[18px] shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  );
}

export function Sidebar() {
  const workspace = useWorkspace();
  const { isAdmin } = usePermissions();
  const collapsedPref = useUI((s) => s.sidebarCollapsed);
  const toggle = useUI((s) => s.toggleSidebar);
  const mobileOpen = useUI((s) => s.mobileNavOpen);
  const setMobileNav = useUI((s) => s.setMobileNav);
  const { data: projects = [] } = useProjects();
  // The sidebar sits above the project routes, so read the key from the URL rather than useParams.
  const activeKey = useMatch("/w/:slug/projects/:key/*")?.params.key;
  const base = `/w/${workspace.slug}`;
  const collapsed = collapsedPref && !mobileOpen;
  const visibleProjects = projects.filter((p) => !p.is_archived);

  return (
    <>
      {mobileOpen && <div className="fixed inset-0 z-30 bg-slate-950/40 lg:hidden" onClick={() => setMobileNav(false)} />}
      <aside
        onClick={(e) => (e.target as HTMLElement).closest("a") && setMobileNav(false)}
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex flex-col border-r border-slate-200/80 bg-white transition-all duration-200 dark:border-slate-800 dark:bg-slate-900",
          "lg:sticky lg:top-0 lg:h-screen lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          collapsed ? "w-[68px]" : "w-64",
        )}
      >
        <div className={cn("flex h-14 items-center px-4", collapsed && "justify-center px-0")}>
          {collapsed ? <Logo className="[&>span]:hidden" /> : <Logo className="text-[15px]" />}
        </div>
        <div className="px-3 pb-2">
          <WorkspaceSwitcher collapsed={collapsed} />
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
          <NavItem to={`${base}/dashboard`} icon={LayoutDashboard} label="Dashboard" collapsed={collapsed} />
          <NavItem to={`${base}/projects`} icon={FolderKanban} label="Projects" collapsed={collapsed} end />
          <NavItem to={`${base}/issues`} icon={List} label="All issues" collapsed={collapsed} />
          <NavItem to={`${base}/reports`} icon={ChartColumn} label="Reports" collapsed={collapsed} />

          {!collapsed && visibleProjects.length > 0 && (
            <p className="px-2.5 pt-5 pb-1.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Projects</p>
          )}
          {collapsed && <div className="my-3 h-px bg-slate-100 dark:bg-slate-800" />}
          {visibleProjects.map((project) => {
            const active = project.key === activeKey;
            return (
              <div key={project.id}>
                <NavLink
                  to={`${base}/projects/${project.key}/board`}
                  title={collapsed ? project.name : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors",
                    collapsed && "justify-center px-0",
                    active
                      ? "text-slate-900 dark:text-white"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100",
                  )}
                >
                  <span
                    className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] text-[9px] font-bold text-white"
                    style={{ backgroundColor: project.color }}
                  >
                    {project.key.charAt(0)}
                  </span>
                  {!collapsed && <span className="truncate">{project.name}</span>}
                </NavLink>
                {active && !collapsed && (
                  <div className="mt-0.5 mb-1 ml-[18px] space-y-0.5 border-l border-slate-200 pl-2.5 dark:border-slate-700">
                    <NavItem to={`${base}/projects/${project.key}/board`} icon={SquareKanban} label="Board" collapsed={false} />
                    <NavItem to={`${base}/projects/${project.key}/backlog`} icon={ListTodo} label="Backlog" collapsed={false} />
                    <NavItem to={`${base}/projects/${project.key}/issues`} icon={List} label="Issues" collapsed={false} />
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="space-y-0.5 border-t border-slate-100 px-3 py-3 dark:border-slate-800">
          <NavItem to={`${base}/members`} icon={Users} label="Members" collapsed={collapsed} />
          {isAdmin && <NavItem to={`${base}/audit`} icon={History} label="Audit log" collapsed={collapsed} />}
          <NavItem to={`${base}/billing`} icon={CreditCard} label="Billing" collapsed={collapsed} />
          <NavItem to={`${base}/settings`} icon={Settings} label="Settings" collapsed={collapsed} />
          <button
            onClick={toggle}
            className={cn(
              "hidden w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-500 hover:bg-slate-100 lg:flex dark:hover:bg-slate-800",
              collapsed && "justify-center px-0",
            )}
          >
            {collapsed ? <PanelLeftOpen className="size-[18px]" /> : <PanelLeftClose className="size-[18px]" />}
            {!collapsed && "Collapse"}
          </button>
        </div>
      </aside>
    </>
  );
}
