export type Role = "owner" | "admin" | "member" | "viewer";
export type Plan = "free" | "pro" | "enterprise";
export type StatusCategory = "todo" | "in_progress" | "done";
export type IssueType = "epic" | "story" | "task" | "bug" | "subtask";
export type Priority = 1 | 2 | 3 | 4 | 5;
export type SprintState = "planned" | "active" | "closed";
export type BoardType = "kanban" | "scrum";

export interface UserMini {
  id: number;
  email: string;
  display_name: string;
  initials: string;
  avatar_color: string;
  job_title: string;
}

export interface Me extends UserMini {
  first_name: string;
  last_name: string;
  email_notifications: boolean;
  is_staff: boolean;
  date_joined: string;
}

export interface AuthResponse {
  access: string;
  refresh: string;
  user: Me;
  workspace?: string | null;
}

export interface Workspace {
  id: number;
  name: string;
  slug: string;
  plan: Plan;
  owner: UserMini;
  role: Role;
  member_count: number;
  project_count: number;
  created_at: string;
}

export interface Member {
  id: number;
  user: UserMini;
  role: Role;
  joined_at: string;
}

export interface Invitation {
  id: number;
  email: string;
  role: Role;
  invited_by: UserMini | null;
  expires_at: string;
  accept_url: string;
  email_sent_at: string | null;
  created_at: string;
}

export interface InvitationPreview {
  email: string;
  role: Role;
  workspace: string;
  workspace_slug: string;
  invited_by: string | null;
  is_pending: boolean;
  user_exists: boolean;
  expires_at: string;
}

export interface WorkflowStatus {
  id: number;
  name: string;
  category: StatusCategory;
  color: string;
  position: number;
}

export interface WorkflowTransitionRule {
  from: number;
  to: number;
}

export interface WorkflowConfig {
  name: string;
  enforce_transitions: boolean;
  statuses: WorkflowStatus[];
  transitions: WorkflowTransitionRule[];
}

export type WorkflowConfigDraft = Omit<WorkflowConfig, "statuses"> & {
  statuses: Array<Omit<WorkflowStatus, "id"> & { id?: number }>;
};

export interface Board {
  id: number;
  project: number;
  name: string;
  board_type: BoardType;
  wip_limits: Record<string, number>;
}

export interface SprintMini {
  id: number;
  name: string;
  state: SprintState;
  start_date: string | null;
  end_date: string | null;
}

export interface Project {
  id: number;
  key: string;
  name: string;
  description: string;
  color: string;
  lead: number | null;
  lead_detail: UserMini | null;
  is_archived: boolean;
  created_at: string;
  statuses: WorkflowStatus[];
  board: Board | null;
  active_sprint: SprintMini | null;
  enforce_transitions: boolean;
  issue_count: number;
  done_count: number;
}

export interface Sprint extends SprintMini {
  project: number;
  goal: string;
  completed_at: string | null;
  issue_count: number;
  done_count: number;
  total_points: number;
  done_points: number;
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface IssueRef {
  id: number;
  key: string;
  title: string;
  issue_type: IssueType;
}

export interface IssueSummary extends IssueRef {
  priority: Priority;
  status: number;
  status_category: StatusCategory;
  assignee_detail: UserMini | null;
}

export interface Issue extends IssueRef {
  number: number;
  project: number;
  project_key: string;
  description?: string;
  priority: Priority;
  status: number;
  status_category: StatusCategory;
  sprint: number | null;
  parent: number | null;
  parent_summary: IssueRef | null;
  assignee: number | null;
  assignee_detail: UserMini | null;
  reporter_detail: UserMini | null;
  story_points: number | null;
  due_date: string | null;
  rank: number;
  labels: number[];
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IssueDetail extends Issue {
  description: string;
  children: IssueSummary[];
}

export interface IssueComment {
  id: number;
  body: string;
  author: UserMini | null;
  mentions: UserMini[];
  created_at: string;
  updated_at: string;
}

export interface IssueAttachment {
  id: number;
  original_name: string;
  content_type: string;
  size: number;
  uploaded_by: UserMini | null;
  download_url: string;
  created_at: string;
}

export interface IssueActivity {
  id: number;
  issue_key: string;
  issue_title: string;
  actor: UserMini | null;
  action: "created" | "updated" | "moved" | "commented" | "attached" | "detached" | "deleted";
  changes: Record<string, unknown>;
  created_at: string;
}

export interface NotificationItem {
  id: number;
  actor: UserMini | null;
  event_key: string;
  title: string;
  body: string;
  url: string;
  read_at: string | null;
  created_at: string;
}

export interface WebhookEndpoint {
  id: number;
  name: string;
  url: string;
  secret: string;
  events: string[];
  is_active: boolean;
  created_by: UserMini | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookDelivery {
  id: number;
  event_id: string;
  event: string;
  state: "pending" | "delivered" | "failed";
  attempts: number;
  response_status: number | null;
  response_body: string;
  last_error: string;
  next_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export type ReportType = "workspace_summary" | "sprint_burndown" | "velocity";

export interface WorkspaceReport {
  id: number;
  report_type: ReportType;
  title: string;
  project: number | null;
  sprint: number | null;
  requested_by: UserMini | null;
  state: "pending" | "ready" | "failed";
  data: Record<string, unknown>;
  error: string;
  created_at: string;
  updated_at: string;
}

export interface BurndownData {
  sprint: string;
  state: SprintState;
  goal: string;
  start_date: string;
  end_date: string;
  total_points: number;
  total_issues: number;
  completed_points: number;
  completed_issues: number;
  days: { date: string; ideal_points: number; remaining_points: number | null; remaining_issues: number | null }[];
}

export interface VelocityData {
  project: string;
  average_points: number;
  sprints: {
    name: string;
    start_date: string | null;
    end_date: string | null;
    completed_points: number;
    completed_issues: number;
    open_issues: number;
  }[];
}

export interface SummaryData {
  issue_count: number;
  by_status: { status__name: string; count: number }[];
  by_priority: { priority: number; count: number }[];
  projects: { project__key: string; project__name: string; count: number }[];
}

export interface AuditEntry {
  id: number;
  entity_type: string;
  entity_label: string;
  project_key: string;
  issue_key: string;
  issue_title: string;
  actor: UserMini | null;
  action: string;
  changes: Record<string, unknown>;
  created_at: string;
}

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface DashboardData {
  totals: {
    total: number;
    open: number;
    done: number;
    in_progress: number;
    overdue: number;
    unassigned: number;
    mine_open: number;
    done_this_week: number;
  };
  by_category: Record<StatusCategory, number>;
  by_type: Record<IssueType, number>;
  by_priority: Record<string, number>;
  workload: { user: UserMini; count: number }[];
  trend: { date: string; created: number; resolved: number }[];
  projects: { id: number; key: string; name: string; color: string; total: number; done: number }[];
  active_sprints: {
    id: number;
    name: string;
    project_key: string;
    project_name: string;
    start_date: string | null;
    end_date: string | null;
    goal: string;
    issue_count: number;
    done_count: number;
    total_points: number;
    done_points: number;
    days_left: number | null;
  }[];
  my_issues: Issue[];
  recent: Issue[];
}
