import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/store/auth";
import type {
  AuthResponse, Board, DashboardData, Invitation, InvitationPreview, Issue, IssueDetail, Label, Me, Member,
  IssueActivity, IssueAttachment, IssueComment, Paginated, Project, Role, Sprint, StatusCategory, WorkflowConfig,
  WorkflowConfigDraft, Workspace,
  AuditEntry, NotificationItem, ReportType, WebhookDelivery, WebhookEndpoint, WorkspaceReport,
} from "@/types";
import { useWorkspaceSlug } from "./useWorkspace";

/* ------------------------------------------------------------------ plumbing */

/** Request helpers bound to the current workspace (sends X-Workspace on every call). */
export function useWsApi() {
  const slug = useWorkspaceSlug();
  return useMemo(() => {
    const headers = { "X-Workspace": slug };
    return {
      slug,
      get: <T>(url: string, params?: object) => api.get<T>(url, { params, headers }).then((r) => r.data),
      post: <T>(url: string, body?: unknown) => api.post<T>(url, body, { headers }).then((r) => r.data),
      put: <T>(url: string, body?: unknown) => api.put<T>(url, body, { headers }).then((r) => r.data),
      patch: <T>(url: string, body?: unknown) => api.patch<T>(url, body, { headers }).then((r) => r.data),
      del: (url: string) => api.delete(url, { headers }).then(() => undefined),
    };
  }, [slug]);
}

const ws = (slug: string) => ["ws", slug] as const;

function refreshWorkData(qc: QueryClient, slug: string) {
  for (const part of ["issues", "issue", "sprints", "projects", "dashboard"]) {
    qc.invalidateQueries({ queryKey: [...ws(slug), part] });
  }
}

type IssueList = Issue[] | Paginated<Issue> | undefined;

function patchIssueLists(qc: QueryClient, slug: string, update: (issue: Issue) => Issue) {
  qc.setQueriesData<IssueList>({ queryKey: [...ws(slug), "issues"] }, (data) => {
    if (!data) return data;
    if (Array.isArray(data)) return data.map(update);
    return { ...data, results: data.results.map(update) };
  });
}

/* ---------------------------------------------------------------------- auth */

export function useMe() {
  const setUser = useAuth((s) => s.setUser);
  const access = useAuth((s) => s.access);
  return useQuery({
    queryKey: ["me"],
    enabled: !!access,
    queryFn: async () => {
      const user = (await api.get<Me>("/auth/me/")).data;
      setUser(user);
      return user;
    },
  });
}

export function useLogin() {
  const signIn = useAuth((s) => s.signIn);
  return useMutation({
    meta: { silent: true },
    mutationFn: (body: { email: string; password: string }) =>
      api.post<AuthResponse>("/auth/login/", body).then((r) => r.data),
    onSuccess: signIn,
  });
}

export interface RegisterBody {
  email: string;
  password: string;
  first_name: string;
  last_name?: string;
  workspace_name?: string;
  invite_token?: string;
}

export function useRegister() {
  const signIn = useAuth((s) => s.signIn);
  return useMutation({
    meta: { silent: true },
    mutationFn: (body: RegisterBody) => api.post<AuthResponse>("/auth/register/", body).then((r) => r.data),
    onSuccess: signIn,
  });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  const setUser = useAuth((s) => s.setUser);
  return useMutation({
    mutationFn: (body: Partial<Pick<Me, "first_name" | "last_name" | "job_title" | "avatar_color" | "email_notifications">>) =>
      api.patch<Me>("/auth/me/", body).then((r) => r.data),
    onSuccess: (user) => {
      setUser(user);
      qc.setQueryData(["me"], user);
      qc.invalidateQueries({ queryKey: ["ws"] });
    },
  });
}

export function useChangePassword() {
  return useMutation({
    meta: { silent: true },
    mutationFn: (body: { current_password: string; new_password: string }) =>
      api.post("/auth/change-password/", body),
  });
}

/* ---------------------------------------------------------------- workspaces */

export function useWorkspaces(enabled = true) {
  return useQuery({
    queryKey: ["workspaces"],
    enabled,
    queryFn: () => api.get<Workspace[]>("/workspaces/").then((r) => r.data),
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string }) => api.post<Workspace>("/workspaces/", body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspaces"] }),
  });
}

export function useUpdateWorkspace() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string }) => w.patch<Workspace>("/workspace/", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspaces"] }),
  });
}

export function useDeleteWorkspace() {
  const w = useWsApi();
  return useMutation({ mutationFn: () => w.del("/workspace/") });
}

export function useInvitationPreview(token: string) {
  return useQuery({
    queryKey: ["invitation", token],
    retry: false,
    queryFn: () => api.get<InvitationPreview>(`/invitations/preview/${token}/`).then((r) => r.data),
  });
}

export function useAcceptInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.post<Workspace>("/invitations/accept/", { token }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspaces"] }),
  });
}

/* ------------------------------------------------------------------- members */

export function useMembers() {
  const w = useWsApi();
  return useQuery({ queryKey: [...ws(w.slug), "members"], queryFn: () => w.get<Member[]>("/members/") });
}

export function useUpdateMember() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role }: { id: number; role: Role }) => w.patch<Member>(`/members/${id}/`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ws(w.slug), "members"] }),
  });
}

export function useRemoveMember() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => w.del(`/members/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...ws(w.slug), "members"] });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

export function useInvitations(enabled = true) {
  const w = useWsApi();
  return useQuery({
    queryKey: [...ws(w.slug), "invitations"],
    enabled,
    queryFn: () => w.get<Invitation[]>("/invitations/"),
  });
}

export function useCreateInvitation() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: Role }) => w.post<Invitation>("/invitations/", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ws(w.slug), "invitations"] }),
  });
}

export function useRevokeInvitation() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => w.del(`/invitations/${id}/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ws(w.slug), "invitations"] }),
  });
}

/* ------------------------------------------------------------------ projects */

export function useProjects() {
  const w = useWsApi();
  return useQuery({ queryKey: [...ws(w.slug), "projects"], queryFn: () => w.get<Project[]>("/projects/") });
}

export function useProject(key: string) {
  const w = useWsApi();
  return useQuery({
    queryKey: [...ws(w.slug), "projects", key],
    queryFn: () => w.get<Project>(`/projects/${key}/`),
  });
}

export interface ProjectBody {
  name: string;
  key?: string;
  description?: string;
  color?: string;
  lead?: number | null;
  board_type?: "kanban" | "scrum";
  is_archived?: boolean;
}

export function useCreateProject() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (body: ProjectBody) => w.post<Project>("/projects/", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...ws(w.slug), "projects"] });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

export function useUpdateProject(key: string) {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<ProjectBody>) => w.patch<Project>(`/projects/${key}/`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...ws(w.slug), "projects"] });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

export function useDeleteProject() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => w.del(`/projects/${key}/`),
    onSuccess: () => {
      refreshWorkData(qc, w.slug);
      qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

export function useUpdateBoard() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, wip_limits }: { id: number; wip_limits: Record<string, number> }) =>
      w.patch<Board>(`/boards/${id}/`, { wip_limits }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ws(w.slug), "projects"] }),
  });
}

export function useWorkflow(projectKey: string, enabled = true) {
  const w = useWsApi();
  return useQuery({
    queryKey: [...ws(w.slug), "workflow", projectKey],
    enabled,
    queryFn: () => w.get<WorkflowConfig>(`/projects/${projectKey}/workflow/`),
  });
}

export function useSaveWorkflow(projectKey: string) {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WorkflowConfigDraft) => w.put<WorkflowConfig>(`/projects/${projectKey}/workflow/`, body),
    onSuccess: (data) => {
      qc.setQueryData([...ws(w.slug), "workflow", projectKey], data);
      qc.invalidateQueries({ queryKey: [...ws(w.slug), "projects", projectKey] });
      refreshWorkData(qc, w.slug);
    },
  });
}

export function useIssueComments(issueKey: string) {
  const w = useWsApi();
  return useQuery({
    queryKey: [...ws(w.slug), "issue", issueKey, "comments"],
    queryFn: () => w.get<IssueComment[]>(`/issues/${issueKey}/comments/`),
  });
}

function invalidateIssueExtras(qc: QueryClient, slug: string, key: string) {
  qc.invalidateQueries({ queryKey: [...ws(slug), "issue", key] });
}

export function useCreateIssueComment(issueKey: string) {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { body: string }) => w.post<IssueComment>(`/issues/${issueKey}/comments/`, body),
    onSuccess: () => invalidateIssueExtras(qc, w.slug, issueKey),
  });
}

export function useEditIssueComment(issueKey: string) {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: string }) => w.patch<IssueComment>(`/issues/${issueKey}/comments/${id}/`, { body }),
    onSuccess: () => invalidateIssueExtras(qc, w.slug, issueKey),
  });
}

export function useDeleteIssueComment(issueKey: string) {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => w.del(`/issues/${issueKey}/comments/${id}/`),
    onSuccess: () => invalidateIssueExtras(qc, w.slug, issueKey),
  });
}

export function useIssueAttachments(issueKey: string) {
  const w = useWsApi();
  return useQuery({
    queryKey: [...ws(w.slug), "issue", issueKey, "attachments"],
    queryFn: () => w.get<IssueAttachment[]>(`/issues/${issueKey}/attachments/`),
  });
}

export function useUploadIssueAttachment(issueKey: string) {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return w.post<IssueAttachment>(`/issues/${issueKey}/attachments/`, body);
    },
    onSuccess: () => invalidateIssueExtras(qc, w.slug, issueKey),
  });
}

export function useDeleteIssueAttachment(issueKey: string) {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => w.del(`/attachments/${id}/`),
    onSuccess: () => invalidateIssueExtras(qc, w.slug, issueKey),
  });
}

export function useIssueActivity(issueKey: string) {
  const w = useWsApi();
  return useQuery({
    queryKey: [...ws(w.slug), "issue", issueKey, "activity"],
    queryFn: () => w.get<IssueActivity[]>(`/issues/${issueKey}/activity/`),
  });
}

export function useDownloadIssueAttachment() {
  const w = useWsApi();
  return useMutation({
    mutationFn: async (attachment: IssueAttachment) => {
      const response = await api.get<Blob>(`/attachments/${attachment.id}/download/`, {
        responseType: "blob", headers: { "X-Workspace": w.slug },
      });
      saveBlob(response.data, attachment.original_name);
    },
  });
}

export function useNotifications() {
  const w = useWsApi();
  return useQuery({
    queryKey: [...ws(w.slug), "notifications"],
    queryFn: () => w.get<{ unread_count: number; results: NotificationItem[] }>("/notifications/"),
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationRead() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => w.post<NotificationItem>(`/notifications/${id}/read/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ws(w.slug), "notifications"] }),
  });
}

export function useMarkAllNotificationsRead() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => w.post<{ updated: number }>("/notifications/read-all/"),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ws(w.slug), "notifications"] }),
  });
}

export function useWebhooks(enabled = true) {
  const w = useWsApi();
  return useQuery({ queryKey: [...ws(w.slug), "webhooks"], enabled, queryFn: () => w.get<WebhookEndpoint[]>("/webhooks/") });
}

export function useCreateWebhook() {
  const w = useWsApi(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Pick<WebhookEndpoint, "name" | "url" | "events">) => w.post<WebhookEndpoint>("/webhooks/", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ws(w.slug), "webhooks"] }),
  });
}

export function useDeleteWebhook() {
  const w = useWsApi(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => w.del(`/webhooks/${id}/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ws(w.slug), "webhooks"] }),
  });
}

export function useTestWebhook() {
  const w = useWsApi(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => w.post<WebhookDelivery>(`/webhooks/${id}/test/`),
    onSuccess: (_delivery, id) => {
      qc.invalidateQueries({ queryKey: [...ws(w.slug), "webhooks"] });
      qc.invalidateQueries({ queryKey: [...ws(w.slug), "webhook-deliveries", id] });
    },
  });
}

export function useRotateWebhookSecret() {
  const w = useWsApi(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => w.post<{ secret: string }>(`/webhooks/${id}/rotate-secret/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ws(w.slug), "webhooks"] }),
  });
}

export function useWebhookDeliveries(id: number | null) {
  const w = useWsApi();
  return useQuery({
    queryKey: [...ws(w.slug), "webhook-deliveries", id],
    enabled: id !== null,
    queryFn: () => w.get<WebhookDelivery[]>(`/webhooks/${id}/deliveries/`),
    refetchInterval: (query) => (query.state.data?.some((d) => d.state === "pending") ? 3000 : false),
  });
}

export function useWorkspaceReports() {
  const w = useWsApi();
  return useQuery({
    queryKey: [...ws(w.slug), "reports"],
    queryFn: () => w.get<WorkspaceReport[]>("/reports/"),
    refetchInterval: (query) => (query.state.data?.some((r) => r.state === "pending") ? 3000 : false),
  });
}

export function useGenerateWorkspaceReport() {
  const w = useWsApi(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { report_type: ReportType; project?: number; sprint?: number }) =>
      w.post<WorkspaceReport>("/reports/", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ws(w.slug), "reports"] }),
  });
}

function saveBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export function useDownloadReport() {
  const w = useWsApi();
  return useMutation({
    mutationFn: async (report: WorkspaceReport) => {
      const response = await api.get<Blob>(`/reports/${report.id}/download/`, {
        responseType: "blob", headers: { "X-Workspace": w.slug },
      });
      saveBlob(response.data, `${report.title.replace(/[^\w-]+/g, "-").toLowerCase()}.csv`);
    },
  });
}

export interface AuditParams {
  search?: string;
  entity_type?: string;
  action?: string;
  actor?: number;
  project?: string;
  date_from?: string;
  date_to?: string;
  page: number;
  page_size: number;
}

export function useAuditLog(params: AuditParams) {
  const w = useWsApi();
  return useQuery({
    queryKey: [...ws(w.slug), "audit-log", params],
    placeholderData: keepPreviousData,
    queryFn: () => w.get<Paginated<AuditEntry>>("/audit-log/", params),
  });
}

export function useResendInvitation() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => w.post<{ queued: boolean }>(`/invitations/${id}/resend/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ws(w.slug), "invitations"] }),
  });
}

/* ------------------------------------------------------------------- sprints */

export function useSprints(projectKey: string | undefined, states = "planned,active") {
  const w = useWsApi();
  return useQuery({
    queryKey: [...ws(w.slug), "sprints", projectKey, states],
    enabled: !!projectKey,
    queryFn: () => w.get<Sprint[]>("/sprints/", { project: projectKey, state: states }),
  });
}

export interface SprintBody {
  project?: number;
  name?: string;
  goal?: string;
  start_date?: string | null;
  end_date?: string | null;
}

export function useSaveSprint() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: SprintBody & { id?: number }) =>
      id ? w.patch<Sprint>(`/sprints/${id}/`, body) : w.post<Sprint>("/sprints/", body),
    onSuccess: () => refreshWorkData(qc, w.slug),
  });
}

export function useDeleteSprint() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => w.del(`/sprints/${id}/`),
    onSuccess: () => refreshWorkData(qc, w.slug),
  });
}

export function useStartSprint() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; start_date?: string; end_date?: string; goal?: string }) =>
      w.post<Sprint>(`/sprints/${id}/start/`, body),
    onSuccess: () => refreshWorkData(qc, w.slug),
  });
}

export function useCompleteSprint() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, moveTo }: { id: number; moveTo: number | null }) =>
      w.post<Sprint>(`/sprints/${id}/complete/`, { move_open_issues_to: moveTo }),
    onSuccess: () => refreshWorkData(qc, w.slug),
  });
}

/* -------------------------------------------------------------------- labels */

export function useLabels() {
  const w = useWsApi();
  return useQuery({ queryKey: [...ws(w.slug), "labels"], queryFn: () => w.get<Label[]>("/labels/") });
}

export function useCreateLabel() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; color: string }) => w.post<Label>("/labels/", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ws(w.slug), "labels"] }),
  });
}

export function useDeleteLabel() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => w.del(`/labels/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...ws(w.slug), "labels"] });
      refreshWorkData(qc, w.slug);
    },
  });
}

/* -------------------------------------------------------------------- issues */

export interface IssueParams {
  project?: string | number;
  sprint?: string | number;
  assignee?: string;
  status?: string;
  status_category?: string;
  issue_type?: string;
  exclude_type?: string;
  priority?: string;
  label?: number;
  parent?: number;
  search?: string;
  ordering?: string;
  overdue?: boolean;
  page?: number;
  page_size?: number;
}

function cleanParams(params: IssueParams) {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== null));
}

export function useIssues(params: IssueParams, options: { enabled?: boolean } = {}) {
  const w = useWsApi();
  const clean = cleanParams(params);
  return useQuery({
    queryKey: [...ws(w.slug), "issues", "list", clean],
    enabled: options.enabled ?? true,
    queryFn: () => w.get<Issue[]>("/issues/", clean),
  });
}

export function useIssuesPage(params: IssueParams) {
  const w = useWsApi();
  const clean = cleanParams({ page_size: 25, ...params, page: params.page ?? 1 });
  return useQuery({
    queryKey: [...ws(w.slug), "issues", "page", clean],
    placeholderData: keepPreviousData,
    queryFn: () => w.get<Paginated<Issue>>("/issues/", clean),
  });
}

export function useIssue(key: string | null) {
  const w = useWsApi();
  return useQuery({
    queryKey: [...ws(w.slug), "issue", key],
    enabled: !!key,
    queryFn: () => w.get<IssueDetail>(`/issues/${key}/`),
  });
}

export interface IssueBody {
  project?: number;
  title?: string;
  description?: string;
  issue_type?: string;
  priority?: number;
  status?: number;
  sprint?: number | null;
  parent?: number | null;
  assignee?: number | null;
  story_points?: number | null;
  due_date?: string | null;
  labels?: number[];
}

export function useCreateIssue() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: IssueBody) => w.post<IssueDetail>("/issues/", body),
    onSuccess: () => refreshWorkData(qc, w.slug),
  });
}

export function useUpdateIssue(key: string) {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: IssueBody) => w.patch<IssueDetail>(`/issues/${key}/`, body),
    onSuccess: (issue) => {
      qc.setQueryData([...ws(w.slug), "issue", key], (old: IssueDetail | undefined) =>
        old ? { ...old, ...issue, children: old.children } : old,
      );
      patchIssueLists(qc, w.slug, (i) => (i.id === issue.id ? { ...i, ...issue } : i));
      refreshWorkData(qc, w.slug);
    },
  });
}

export function useDeleteIssue() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => w.del(`/issues/${key}/`),
    onSuccess: () => refreshWorkData(qc, w.slug),
  });
}

export interface MoveArgs {
  issue: Issue;
  status?: number;
  statusCategory?: StatusCategory;
  sprint?: number | null;
  prevId: number | null;
  nextId: number | null;
  rank: number | null;
}

/** Drag-and-drop move with an optimistic cache update and automatic rollback on error. */
export function useMoveIssue() {
  const w = useWsApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ issue, status, sprint, prevId, nextId }: MoveArgs) =>
      w.post<Issue>(`/issues/${issue.key}/move/`, {
        ...(status !== undefined && { status }),
        ...(sprint !== undefined && { sprint }),
        prev_id: prevId,
        next_id: nextId,
      }),
    onMutate: async (args) => {
      await qc.cancelQueries({ queryKey: [...ws(w.slug), "issues"] });
      const snapshot = qc.getQueriesData<IssueList>({ queryKey: [...ws(w.slug), "issues"] });
      patchIssueLists(qc, w.slug, (i) =>
        i.id !== args.issue.id
          ? i
          : {
              ...i,
              status: args.status ?? i.status,
              status_category: args.statusCategory ?? i.status_category,
              sprint: args.sprint === undefined ? i.sprint : args.sprint,
              rank: args.rank ?? i.rank,
            },
      );
      return { snapshot };
    },
    onError: (_error, _args, context) => {
      context?.snapshot.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => refreshWorkData(qc, w.slug),
  });
}

/* ----------------------------------------------------------------- dashboard */

export function useDashboard() {
  const w = useWsApi();
  return useQuery({ queryKey: [...ws(w.slug), "dashboard"], queryFn: () => w.get<DashboardData>("/dashboard/") });
}
