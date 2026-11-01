import { useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, CircleUser, LogOut, Menu, Monitor, Moon, Plus, Search, Sun } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { Avatar, Kbd } from "@/components/ui/Misc";
import { usePermissions, useWorkspace } from "@/hooks/useWorkspace";
import { useMarkAllNotificationsRead, useMarkNotificationRead, useNotifications } from "@/hooks/queries";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/utils";
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
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notifications = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
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

      <div className="relative">
        <IconButton label="Notifications" onClick={() => setNotificationsOpen((open) => !open)}>
          <Bell className="size-4" />
          {!!notifications.data?.unread_count && <span className="absolute top-0 right-0 flex size-4 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold text-white">{notifications.data.unread_count > 9 ? "9+" : notifications.data.unread_count}</span>}
        </IconButton>
        {notificationsOpen && <div className="absolute top-11 right-0 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800"><div><p className="text-sm font-semibold">Notifications</p><p className="text-[11px] text-slate-500">{notifications.data?.unread_count ?? 0} unread</p></div><button onClick={() => markAllRead.mutate()} className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 disabled:opacity-50" disabled={!notifications.data?.unread_count}><CheckCheck className="size-3.5" />Mark all read</button></div>
          <div className="max-h-96 overflow-y-auto">{(notifications.data?.results ?? []).length === 0 ? <p className="px-4 py-8 text-center text-xs text-slate-400">You’re all caught up.</p> : notifications.data?.results.map((item) => <button key={item.id} onClick={() => { if (!item.read_at) markRead.mutate(item.id); setNotificationsOpen(false); if (item.url) navigate(item.url); }} className={`flex w-full gap-3 border-b border-slate-100 px-4 py-3 text-left last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60 ${!item.read_at ? "bg-brand-50/50 dark:bg-brand-500/5" : ""}`}><span className={`mt-1 size-2 shrink-0 rounded-full ${item.read_at ? "bg-transparent" : "bg-brand-500"}`} /><span className="min-w-0 flex-1"><span className="block text-xs font-semibold">{item.title}</span><span className="mt-0.5 block line-clamp-2 text-xs text-slate-500">{item.body}</span><span className="mt-1 block text-[10px] text-slate-400">{timeAgo(item.created_at)}</span></span></button>)}</div>
        </div>}
      </div>

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
