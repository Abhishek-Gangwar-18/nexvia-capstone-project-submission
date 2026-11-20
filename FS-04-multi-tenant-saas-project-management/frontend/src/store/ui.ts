import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { IssueType } from "@/types";

export type Theme = "light" | "dark" | "system";

export interface CreateIssueDefaults {
  projectId?: number;
  statusId?: number;
  sprintId?: number | null;
  parentId?: number | null;
  issueType?: IssueType;
}

interface UIState {
  theme: Theme;
  sidebarCollapsed: boolean;
  mobileNavOpen: boolean;
  lastWorkspace: string | null;
  createIssue: { open: boolean; defaults: CreateIssueDefaults };
  paletteOpen: boolean;
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  setMobileNav: (open: boolean) => void;
  setLastWorkspace: (slug: string | null) => void;
  openCreateIssue: (defaults?: CreateIssueDefaults) => void;
  closeCreateIssue: () => void;
  setPaletteOpen: (open: boolean) => void;
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      theme: "system",
      sidebarCollapsed: false,
      mobileNavOpen: false,
      lastWorkspace: null,
      createIssue: { open: false, defaults: {} },
      paletteOpen: false,
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setMobileNav: (mobileNavOpen) => set({ mobileNavOpen }),
      setLastWorkspace: (lastWorkspace) => set({ lastWorkspace }),
      openCreateIssue: (defaults = {}) => set({ createIssue: { open: true, defaults } }),
      closeCreateIssue: () => set((s) => ({ createIssue: { ...s.createIssue, open: false } })),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    }),
    {
      name: "flowboard-ui",
      partialize: (s) => ({ theme: s.theme, sidebarCollapsed: s.sidebarCollapsed, lastWorkspace: s.lastWorkspace }),
    },
  ),
);

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

/** Resolves "system" against the OS setting and keeps <html class="dark"> in sync. */
export function useResolvedTheme(): "light" | "dark" {
  const theme = useUI((s) => s.theme);
  const [systemDark, setSystemDark] = useState(() => darkQuery().matches);

  useEffect(() => {
    const query = darkQuery();
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolved = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);
  return resolved;
}
