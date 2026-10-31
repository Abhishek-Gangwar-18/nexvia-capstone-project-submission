import { Combobox, ComboboxInput, ComboboxOption, ComboboxOptions, Dialog, DialogBackdrop, DialogPanel } from "@headlessui/react";
import { CornerDownLeft, FolderKanban, LayoutDashboard, List, Moon, Plus, Search, Settings, Users } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { TypeIcon, useIssueDrawer } from "@/components/issues/IssueMeta";
import { Kbd, Spinner } from "@/components/ui/Misc";
import { useIssues, useProjects } from "@/hooks/queries";
import { usePermissions, useWorkspace } from "@/hooks/useWorkspace";
import { cn } from "@/lib/utils";
import { useUI } from "@/store/ui";

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

function useDebounced<T>(value: T, delay = 200) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export function CommandPalette() {
  const open = useUI((s) => s.paletteOpen);
  const setOpen = useUI((s) => s.setPaletteOpen);
  const openCreate = useUI((s) => s.openCreateIssue);
  const setTheme = useUI((s) => s.setTheme);
  const theme = useUI((s) => s.theme);
  const workspace = useWorkspace();
  const { canEdit } = usePermissions();
  const navigate = useNavigate();
  const drawer = useIssueDrawer();
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim());
  const projects = useProjects().data ?? [];
  const issues = useIssues({ search }, { enabled: open && search.length >= 2 });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useUI.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const base = `/w/${workspace.slug}`;
  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (text: string) => !q || text.toLowerCase().includes(q);
    const actions: PaletteItem[] = [
      ...(canEdit ? [{ id: "create", group: "Actions", label: "Create issue", hint: "C", icon: <Plus className="size-4" />, run: () => openCreate() }] : []),
      { id: "dash", group: "Navigation", label: "Go to dashboard", icon: <LayoutDashboard className="size-4" />, run: () => navigate(`${base}/dashboard`) },
      { id: "projects", group: "Navigation", label: "Go to projects", icon: <FolderKanban className="size-4" />, run: () => navigate(`${base}/projects`) },
      { id: "issues", group: "Navigation", label: "Go to all issues", icon: <List className="size-4" />, run: () => navigate(`${base}/issues`) },
      { id: "members", group: "Navigation", label: "Go to members", icon: <Users className="size-4" />, run: () => navigate(`${base}/members`) },
      { id: "settings", group: "Navigation", label: "Go to settings", icon: <Settings className="size-4" />, run: () => navigate(`${base}/settings`) },
      {
        id: "theme", group: "Actions", label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        icon: <Moon className="size-4" />, run: () => setTheme(theme === "dark" ? "light" : "dark"),
      },
    ].filter((a) => match(a.label));
    const projectItems: PaletteItem[] = projects
      .filter((p) => !p.is_archived && (match(p.name) || match(p.key)))
      .slice(0, 6)
      .map((p) => ({
        id: `p-${p.id}`, group: "Projects", label: p.name, hint: p.key,
        icon: <span className="size-3.5 rounded" style={{ backgroundColor: p.color }} />,
        run: () => navigate(`${base}/projects/${p.key}/board`),
      }));
    const issueItems: PaletteItem[] = (search.length >= 2 ? issues.data ?? [] : []).slice(0, 8).map((i) => ({
      id: `i-${i.id}`, group: "Issues", label: i.title, hint: i.key,
      icon: <TypeIcon type={i.issue_type} />,
      run: () => drawer.open(i.key),
    }));
    return [...issueItems, ...projectItems, ...actions];
  }, [query, search, canEdit, projects, issues.data, base, theme, navigate, openCreate, setTheme, drawer]);

  const groups = items.reduce<Record<string, PaletteItem[]>>((acc, item) => {
    (acc[item.group] ??= []).push(item);
    return acc;
  }, {});

  return (
    <Dialog open={open} onClose={close} className="relative z-50">
      <DialogBackdrop transition className="fixed inset-0 bg-slate-950/40 backdrop-blur-sm transition duration-150 data-closed:opacity-0" />
      <div className="fixed inset-0 overflow-y-auto p-4 pt-[12vh]">
        <DialogPanel
          transition
          className="mx-auto max-w-xl overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/5 transition duration-150 data-closed:scale-95 data-closed:opacity-0 dark:bg-slate-900 dark:ring-slate-700"
        >
          <Combobox<PaletteItem | null>
            onChange={(item) => {
              if (!item) return;
              close();
              item.run();
            }}
          >
            <div className="flex items-center gap-3 border-b border-slate-100 px-4 dark:border-slate-800">
              <Search className="size-5 text-slate-400" />
              <ComboboxInput
                autoFocus
                className="h-14 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
                placeholder="Search issues by key or text, jump to a project, run an action…"
                onChange={(e) => setQuery(e.target.value)}
              />
              {issues.isFetching && <Spinner className="size-4" />}
            </div>
            <ComboboxOptions static className="max-h-[50vh] overflow-y-auto p-2">
              {items.length === 0 && (
                <p className="px-3 py-10 text-center text-sm text-slate-500">No results for “{query}”.</p>
              )}
              {Object.entries(groups).map(([group, groupItems]) => (
                <div key={group} className="mb-1">
                  <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{group}</p>
                  {groupItems.map((item) => (
                    <ComboboxOption
                      key={item.id}
                      value={item}
                      className={cn(
                        "group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-700 select-none",
                        "data-focus:bg-brand-50 data-focus:text-brand-900 dark:text-slate-300 dark:data-focus:bg-brand-500/15 dark:data-focus:text-white",
                      )}
                    >
                      <span className="flex size-5 items-center justify-center text-slate-400 group-data-focus:text-brand-600">{item.icon}</span>
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.hint && <span className="text-xs font-medium text-slate-400">{item.hint}</span>}
                      <CornerDownLeft className="invisible size-3.5 text-slate-400 group-data-focus:visible" />
                    </ComboboxOption>
                  ))}
                </div>
              ))}
            </ComboboxOptions>
          </Combobox>
          <div className="flex items-center gap-4 border-t border-slate-100 bg-slate-50/60 px-4 py-2 text-[11px] text-slate-500 dark:border-slate-800 dark:bg-slate-900/60">
            <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
            <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
            <span className="flex items-center gap-1"><Kbd>Esc</Kbd> close</span>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
