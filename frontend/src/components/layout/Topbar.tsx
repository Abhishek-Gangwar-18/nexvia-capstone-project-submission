import { useQueryClient } from "@tanstack/react-query";
import { CircleUser, CreditCard, LogOut, Menu, Monitor, Moon, Plus, Search, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { Avatar, Kbd } from "@/components/ui/Misc";
import { usePermissions, useWorkspace } from "@/hooks/useWorkspace";
import { logoutSession } from "@/lib/session";
import { PLANS } from "@/lib/constants";
import { useAuth } from "@/store/auth";
import { useUI, type Theme } from "@/store/ui";
import { NotificationBell } from "./NotificationBell";

const themeIcons: Record<Theme, ReactNode> = {
  light: <Sun className="size-4" />,
  dark: <Moon className="size-4" />,
  system: <Monitor className="size-4" />,
};

export function useLogout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    // Only a confirmed server logout ends the session (here and in other tabs); otherwise the httpOnly cookie
    // would still be valid and a reload would quietly sign the user back in.
    const loggedOut = await logoutSession(() => navigate("/login", { replace: true }));
    if (!loggedOut) {
      toast.error("Couldn't log out. Check your connection and try again.");
      return;
    }
    qc.clear();
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
        className="flex h-9 w-full min-w-0 max-w-sm cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-400 transition hover:border-slate-300 hover:bg-white dark:border-slate-700 dark:bg-slate-800/60 dark:hover:bg-slate-800"
      >
        <Search className="size-4" />
        <span className="min-w-0 flex-1 truncate text-left">Search issues, projects…</span>
        <span className="hidden gap-0.5 sm:flex">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <div className="flex-1" />

      {canEdit && (
        <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => openCreate()}>
          <span className="hidden sm:inline">Create</span>
          <span className="ml-1 hidden sm:inline-flex">
            <Kbd className="border-white/20 bg-white/15 text-white dark:border-white/20 dark:bg-white/15 dark:text-white">C</Kbd>
          </span>
        </Button>
      )}

      <IconButton label={`Theme: ${theme}`} onClick={() => setTheme(nextTheme[theme])}>
        {themeIcons[theme]}
      </IconButton>

      <NotificationBell />

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
          { label: "Plan & billing", icon: <CreditCard className="size-4" />, onClick: () => navigate(`/w/${workspace.slug}/billing`), hint: PLANS[workspace.plan].label },
          { label: "Search & commands", icon: <Search className="size-4" />, onClick: () => setPalette(true), hint: "Ctrl K" },
          { separator: true, label: "" },
          { label: "Log out", icon: <LogOut className="size-4" />, onClick: logout, danger: true },
        ]}
      />
    </header>
  );
}
