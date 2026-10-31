import { useQueryClient } from "@tanstack/react-query";
import { CircleUser, LogOut, Menu, Monitor, Moon, Plus, Search, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { Avatar, Kbd } from "@/components/ui/Misc";
import { usePermissions, useWorkspace } from "@/hooks/useWorkspace";
import { api } from "@/lib/api";
import { useAuth } from "@/store/auth";
import { useUI, type Theme } from "@/store/ui";

const themeIcons: Record<Theme, ReactNode> = {
  light: <Sun className="size-4" />,
  dark: <Moon className="size-4" />,
  system: <Monitor className="size-4" />,
};

export function useLogout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    const refresh = useAuth.getState().refresh;
    try {
      if (refresh) await api.post("/auth/logout/", { refresh });
    } catch {
      /* token may already be invalid */
    }
    useAuth.getState().clear();
    qc.clear();
    navigate("/login");
  };
}

export function Topbar() {
  const workspace = useWorkspace();
  const { canEdit } = usePermissions();
  const user = useAuth((s) => s.user);
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const openCreate = useUI((s) => s.openCreateIssue);
  const setPalette = useUI((s) => s.setPaletteOpen);
  const setMobileNav = useUI((s) => s.setMobileNav);
  const navigate = useNavigate();
  const logout = useLogout();
  const nextTheme: Record<Theme, Theme> = { light: "dark", dark: "system", system: "light" };

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-slate-200/80 bg-white/80 px-4 backdrop-blur-md sm:px-6 dark:border-slate-800 dark:bg-slate-900/80">
      <IconButton label="Open navigation" className="lg:hidden" onClick={() => setMobileNav(true)}>
        <Menu className="size-5" />
      </IconButton>

      <button
        onClick={() => setPalette(true)}
        className="flex h-9 w-full max-w-sm cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-400 transition hover:border-slate-300 hover:bg-white dark:border-slate-700 dark:bg-slate-800/60 dark:hover:bg-slate-800"
      >
        <Search className="size-4" />
        <span className="flex-1 text-left">Search issues, projects…</span>
        <span className="hidden gap-0.5 sm:flex">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <div className="flex-1" />

      {canEdit && (
        <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => openCreate()}>
          <span className="hidden sm:inline">Create</span>
          <Kbd className="ml-1 hidden border-white/20 bg-white/15 text-white sm:inline-flex dark:border-white/20 dark:bg-white/15 dark:text-white">C</Kbd>
        </Button>
      )}

      <IconButton label={`Theme: ${theme}`} onClick={() => setTheme(nextTheme[theme])}>
        {themeIcons[theme]}
      </IconButton>

      <Dropdown
        header={
          <div className="flex items-center gap-2.5">
            <Avatar user={user} size="md" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{user?.display_name}</p>
              <p className="truncate text-xs text-slate-500">{user?.email}</p>
            </div>
          </div>
        }
        trigger={
          <button className="cursor-pointer rounded-full transition hover:ring-4 hover:ring-slate-100 dark:hover:ring-slate-800" aria-label="Account menu">
            <Avatar user={user} size="md" />
          </button>
        }
        items={[
          { separator: true, label: "" },
          { label: "Profile & security", icon: <CircleUser className="size-4" />, onClick: () => navigate(`/w/${workspace.slug}/profile`) },
          { label: "Light theme", icon: <Sun className="size-4" />, onClick: () => setTheme("light"), hint: theme === "light" ? "✓" : undefined },
          { label: "Dark theme", icon: <Moon className="size-4" />, onClick: () => setTheme("dark"), hint: theme === "dark" ? "✓" : undefined },
          { label: "System theme", icon: <Monitor className="size-4" />, onClick: () => setTheme("system"), hint: theme === "system" ? "✓" : undefined },
          { separator: true, label: "" },
          { label: "Log out", icon: <LogOut className="size-4" />, onClick: logout, danger: true },
        ]}
      />
    </header>
  );
}
