import { format, parseISO } from "date-fns";
import {
  CircleCheck, CircleDot, Clock, Inbox, Rocket, Target, TriangleAlert, TrendingUp, type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { PageBody, PageHeader } from "@/components/layout/PageHeader";
import { PriorityIcon, TypeIcon, useIssueDrawer } from "@/components/issues/IssueMeta";
import { Avatar, EmptyState, ProgressBar, Skeleton } from "@/components/ui/Misc";
import { useDashboard } from "@/hooks/queries";
import { useWorkspace } from "@/hooks/useWorkspace";
import { CATEGORIES, ISSUE_TYPES } from "@/lib/constants";
import { cn, percent, timeAgo } from "@/lib/utils";
import { useAuth } from "@/store/auth";
import type { Issue, IssueType, StatusCategory } from "@/types";

const TYPE_COLORS: Record<IssueType, string> = {
  story: "#10b981", task: "#0ea5e9", bug: "#f43f5e", epic: "#8b5cf6", subtask: "#06b6d4",
};

const tooltipStyle = {
  background: "var(--tooltip-bg)",
  border: "1px solid var(--tooltip-border)",
  borderRadius: 12,
  fontSize: 12,
  boxShadow: "0 10px 30px -10px rgb(0 0 0 / 0.25)",
};

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function StatCard({
  icon: Icon, label, value, sub, tone,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone: string;
}) {
  return (
    <div className="card group p-5 transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{label}</p>
        <span className={cn("flex size-9 items-center justify-center rounded-xl", tone)}>
          <Icon className="size-[18px]" />
        </span>
      </div>
      <p className="mt-2 text-3xl font-bold tracking-tight">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

function Panel({ title, action, children, className }: { title: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("card flex flex-col p-5", className)}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function IssueList({ issues, empty }: { issues: Issue[]; empty: string }) {
  const { open } = useIssueDrawer();
  if (!issues.length) return <p className="py-8 text-center text-sm text-slate-400">{empty}</p>;
  return (
    <ul className="-mx-2 space-y-0.5">
      {issues.map((issue) => (
        <li key={issue.id}>
          <button
            onClick={() => open(issue.key)}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/60"
          >
            <TypeIcon type={issue.issue_type} />
            <span className="w-16 shrink-0 text-xs font-semibold text-slate-500">{issue.key}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{issue.title}</span>
            <span className={cn("hidden rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase sm:inline", CATEGORIES[issue.status_category].badge)}>
              {CATEGORIES[issue.status_category].label}
            </span>
            <PriorityIcon priority={issue.priority} />
            <span className="hidden w-16 text-right text-[11px] text-slate-400 md:inline">{timeAgo(issue.updated_at)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function DashboardPage() {
  const workspace = useWorkspace();
  const user = useAuth((s) => s.user);
  const { data, isLoading } = useDashboard();

  if (isLoading || !data) {
    return (
      <PageBody className="pt-6">
        <Skeleton className="mb-6 h-10 w-72" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-80 lg:col-span-2" />
          <Skeleton className="h-80" />
        </div>
      </PageBody>
    );
  }

  const { totals } = data;
  const categoryData = (Object.keys(CATEGORIES) as StatusCategory[]).map((c) => ({
    name: CATEGORIES[c].label, value: data.by_category[c], color: CATEGORIES[c].hex,
  }));
  const typeData = (Object.keys(ISSUE_TYPES) as IssueType[])
    .map((t) => ({ name: ISSUE_TYPES[t].label, value: data.by_type[t], color: TYPE_COLORS[t] }))
    .filter((d) => d.value > 0);
  const trend = data.trend.map((d) => ({ ...d, label: format(parseISO(d.date), "MMM d") }));
  const completion = percent(totals.done, totals.total);
  const maxLoad = Math.max(1, ...data.workload.map((w) => w.count));

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${user?.display_name.split(" ")[0] ?? "there"} 👋`}
        description={`Here's what's happening across ${workspace.name} today.`}
      />
      <PageBody className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            icon={CircleDot}
            label="Open issues"
            value={totals.open}
            sub={`${totals.in_progress} in progress · ${totals.unassigned} unassigned`}
            tone="bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400"
          />
          <StatCard
            icon={CircleCheck}
            label="Completed"
            value={totals.done}
            sub={`${completion}% of all issues · ${totals.done_this_week} this week`}
            tone="bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400"
          />
          <StatCard
            icon={Target}
            label="Assigned to you"
            value={totals.mine_open}
            sub="Open issues on your plate"
            tone="bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-400"
          />
          <StatCard
            icon={TriangleAlert}
            label="Overdue"
            value={totals.overdue}
            sub={totals.overdue ? "Past their due date" : "Nothing overdue. Nice!"}
            tone="bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400"
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Panel
            title="Created vs resolved"
            className="lg:col-span-2"
            action={<span className="flex items-center gap-1 text-xs text-slate-500"><TrendingUp className="size-3.5" /> Last 14 days</span>}
          >
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gCreated" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6366f1" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gResolved" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#22c55e" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Area type="monotone" dataKey="created" name="Created" stroke="#6366f1" strokeWidth={2} fill="url(#gCreated)" />
                  <Area type="monotone" dataKey="resolved" name="Resolved" stroke="#22c55e" strokeWidth={2} fill="url(#gResolved)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel title="Issues by status">
            <div className="relative h-48">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={categoryData} dataKey="value" nameKey="name" innerRadius={58} outerRadius={80} paddingAngle={3} stroke="none">
                    {categoryData.map((d) => <Cell key={d.name} fill={d.color} />)}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-bold">{completion}%</span>
                <span className="text-[11px] text-slate-500">done</span>
              </div>
            </div>
            <div className="mt-3 space-y-1.5">
              {categoryData.map((d) => (
                <div key={d.name} className="flex items-center gap-2 text-sm">
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: d.color }} />
                  <span className="flex-1 text-slate-600 dark:text-slate-400">{d.name}</span>
                  <span className="font-semibold">{d.value}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Active sprints" className="lg:col-span-2">
            {data.active_sprints.length === 0 ? (
              <EmptyState icon={<Rocket className="size-5" />} title="No active sprints" description="Start a sprint from a project's backlog." className="py-8" />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {data.active_sprints.map((sprint) => (
                  <Link
                    key={sprint.id}
                    to={`/w/${workspace.slug}/projects/${sprint.project_key}/board`}
                    className="rounded-xl border border-slate-200 p-4 transition hover:border-brand-300 hover:shadow-sm dark:border-slate-800 dark:hover:border-brand-500/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold">{sprint.name}</p>
                      {sprint.days_left !== null && (
                        <span className="flex shrink-0 items-center gap-1 text-xs text-slate-500">
                          <Clock className="size-3.5" /> {sprint.days_left}d left
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-500">{sprint.goal || sprint.project_name}</p>
                    <div className="mt-3 flex justify-between text-xs text-slate-500">
                      <span>{sprint.done_count}/{sprint.issue_count} issues</span>
                      <span>{sprint.done_points}/{sprint.total_points} pts</span>
                    </div>
                    <ProgressBar className="mt-1.5" value={percent(sprint.done_points, sprint.total_points)} />
                  </Link>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Issue types">
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={typeData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--chart-grid)", opacity: 0.4 }} />
                  <Bar dataKey="value" name="Issues" radius={[6, 6, 0, 0]} maxBarSize={36}>
                    {typeData.map((d) => <Cell key={d.name} fill={d.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Assigned to you" className="lg:col-span-2">
            <IssueList issues={data.my_issues} empty="Nothing assigned to you right now 🎉" />
          </Panel>
          <Panel title="Team workload" action={<span className="text-xs text-slate-500">open issues</span>}>
            {data.workload.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-400">No assigned work yet.</p>
            ) : (
              <ul className="space-y-3">
                {data.workload.map(({ user: member, count }) => (
                  <li key={member.id} className="flex items-center gap-3">
                    <Avatar user={member} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between text-xs">
                        <span className="truncate font-medium">{member.display_name}</span>
                        <span className="text-slate-500">{count}</span>
                      </div>
                      <ProgressBar className="mt-1" value={(count / maxLoad) * 100} color="bg-brand-500" />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Recently updated" className="lg:col-span-2">
            <IssueList issues={data.recent} empty="No issues yet." />
          </Panel>
          <Panel title="Projects">
            {data.projects.length === 0 ? (
              <EmptyState icon={<Inbox className="size-5" />} title="No projects" className="py-6" />
            ) : (
              <ul className="space-y-3.5">
                {data.projects.map((p) => (
                  <li key={p.id}>
                    <Link to={`/w/${workspace.slug}/projects/${p.key}/board`} className="group block">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="size-2.5 rounded-sm" style={{ backgroundColor: p.color }} />
                        <span className="flex-1 truncate font-medium group-hover:text-brand-600">{p.name}</span>
                        <span className="text-xs text-slate-500">{percent(p.done, p.total)}%</span>
                      </div>
                      <ProgressBar className="mt-1.5" value={percent(p.done, p.total)} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </PageBody>
    </>
  );
}
