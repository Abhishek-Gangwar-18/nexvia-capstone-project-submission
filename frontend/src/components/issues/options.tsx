import { Avatar } from "@/components/ui/Misc";
import type { Option } from "@/components/ui/Select";
import { ISSUE_TYPE_ORDER, ISSUE_TYPES, PRIORITIES, PRIORITY_ORDER } from "@/lib/constants";
import type { Issue, IssueType, Label, Member, Priority, Project, Sprint, WorkflowStatus } from "@/types";
import { LabelChip, PriorityIcon, StatusDot, TypeIcon } from "./IssueMeta";

/** Option builders shared by the create modal, the drawer and the filter bars. */

export const typeOptions = (types: IssueType[] = ISSUE_TYPE_ORDER): Option<IssueType>[] =>
  types.map((t) => ({ value: t, label: ISSUE_TYPES[t].label, icon: <TypeIcon type={t} /> }));

export const priorityOptions: Option<Priority>[] = PRIORITY_ORDER.map((p) => ({
  value: p,
  label: PRIORITIES[p].label,
  icon: <PriorityIcon priority={p} />,
}));

export const statusOptions = (statuses: WorkflowStatus[]): Option<number>[] =>
  statuses.map((s) => ({ value: s.id, label: s.name, icon: <StatusDot color={s.color} /> }));

/** Active members only (the API refuses to newly assign deactivated people), plus `currentId` so a value
 * that is already set still displays. */
export const memberOptions = (
  members: Member[], unassignedLabel = "Unassigned", currentId: number | null = null,
): Option<number | null>[] => [
  { value: null, label: unassignedLabel, icon: <Avatar user={null} size="xs" /> },
  ...members
    .filter((m) => m.user.is_active || m.user.id === currentId)
    .map((m) => ({
      value: m.user.id,
      label: m.user.is_active ? m.user.display_name : `${m.user.display_name} (deactivated)`,
      icon: <Avatar user={m.user} size="xs" />,
    })),
];

export const sprintOptions = (sprints: Sprint[]): Option<number | null>[] => [
  { value: null, label: "Backlog" },
  ...sprints.map((s) => ({ value: s.id, label: s.name, hint: s.state === "active" ? "Active" : undefined })),
];

export const projectOptions = (projects: Project[]): Option<number>[] =>
  projects.map((p) => ({
    value: p.id,
    label: p.name,
    hint: p.key,
    icon: <span className="size-3 shrink-0 rounded" style={{ backgroundColor: p.color }} />,
  }));

export const epicOptions = (epics: Issue[]): Option<number | null>[] => [
  { value: null, label: "No epic" },
  ...epics.map((e) => ({ value: e.id, label: e.title, hint: e.key, icon: <TypeIcon type="epic" /> })),
];

export const labelOptions = (labels: Label[]): Option<number>[] =>
  labels.map((l) => ({ value: l.id, label: l.name, icon: <LabelChip label={{ ...l, name: "●" }} /> }));
