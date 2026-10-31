import {
  Bookmark, Bug, ChevronDown, ChevronsDown, ChevronsUp, ChevronUp, Crown, Equal, Eye, GitBranch, Shield,
  SquareCheckBig, User, Zap, type LucideIcon,
} from "lucide-react";
import type { IssueType, Plan, Priority, Role, StatusCategory } from "@/types";

export const ISSUE_TYPES: Record<IssueType, { label: string; icon: LucideIcon; bg: string }> = {
  epic: { label: "Epic", icon: Zap, bg: "bg-violet-500" },
  story: { label: "Story", icon: Bookmark, bg: "bg-emerald-500" },
  task: { label: "Task", icon: SquareCheckBig, bg: "bg-sky-500" },
  bug: { label: "Bug", icon: Bug, bg: "bg-rose-500" },
  subtask: { label: "Sub-task", icon: GitBranch, bg: "bg-cyan-500" },
};
export const ISSUE_TYPE_ORDER: IssueType[] = ["story", "task", "bug", "epic", "subtask"];

export const PRIORITIES: Record<Priority, { label: string; icon: LucideIcon; color: string }> = {
  5: { label: "Highest", icon: ChevronsUp, color: "text-rose-600 dark:text-rose-400" },
  4: { label: "High", icon: ChevronUp, color: "text-orange-500 dark:text-orange-400" },
  3: { label: "Medium", icon: Equal, color: "text-amber-500 dark:text-amber-400" },
  2: { label: "Low", icon: ChevronDown, color: "text-sky-500 dark:text-sky-400" },
  1: { label: "Lowest", icon: ChevronsDown, color: "text-sky-400 dark:text-sky-300" },
};
export const PRIORITY_ORDER: Priority[] = [5, 4, 3, 2, 1];

export const CATEGORIES: Record<StatusCategory, { label: string; badge: string; hex: string }> = {
  todo: {
    label: "To Do",
    badge: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    hex: "#94a3b8",
  },
  in_progress: {
    label: "In Progress",
    badge: "bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
    hex: "#3b82f6",
  },
  done: {
    label: "Done",
    badge: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    hex: "#22c55e",
  },
};

export const ROLES: Record<Role, { label: string; icon: LucideIcon; description: string; badge: string }> = {
  owner: {
    label: "Owner",
    icon: Crown,
    description: "Full control, including billing and deleting the workspace.",
    badge: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30",
  },
  admin: {
    label: "Admin",
    icon: Shield,
    description: "Manage projects, members, invitations and settings.",
    badge: "bg-brand-50 text-brand-700 ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/30",
  },
  member: {
    label: "Member",
    icon: User,
    description: "Create and edit issues, sprints and labels.",
    badge: "bg-slate-50 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  },
  viewer: {
    label: "Viewer",
    icon: Eye,
    description: "Read-only access to everything in the workspace.",
    badge: "bg-slate-50 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700",
  },
};

export const PLANS: Record<Plan, { label: string; badge: string }> = {
  free: { label: "Free", badge: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  pro: { label: "Pro", badge: "bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300" },
  enterprise: {
    label: "Enterprise",
    badge: "bg-gradient-to-r from-amber-100 to-orange-100 text-orange-700 dark:from-amber-500/20 dark:to-orange-500/20 dark:text-orange-300",
  },
};

export const PROJECT_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#f43f5e", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6",
];
export const AVATAR_COLORS = PROJECT_COLORS;

export const DEMO_ACCOUNTS = [
  { email: "owner@acme.test", label: "Acme · Owner" },
  { email: "admin@globex.test", label: "Globex · Admin" },
  { email: "viewer@initech.test", label: "Initech · Viewer" },
  { email: "alex@flowboard.test", label: "2 workspaces" },
];
export const DEMO_PASSWORD = "Demo@1234";
