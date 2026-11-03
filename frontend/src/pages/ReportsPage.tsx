import { format, parseISO } from "date-fns";
import { ChartColumn, Download, Flame, Gauge, LayoutList, Plus, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { toast } from "sonner";
import { PageBody, PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Input";
import { Avatar, EmptyState, Skeleton } from "@/components/ui/Misc";
import { Select } from "@/components/ui/Select";
import {
  useDownloadReport, useGenerateWorkspaceReport, useProjects, useSprints, useWorkspaceReports,
} from "@/hooks/queries";
import { usePermissions } from "@/hooks/useWorkspace";
import { cn, formatDate, timeAgo } from "@/lib/utils";
import type {
  BurndownData, ReportType, SummaryData, VelocityData, WorkspaceReport,
} from "@/types";

const REPORT_TYPES: { value: ReportType; label: string; text: string; icon: LucideIcon }[] = [
  { value: "sprint_burndown", label: "Sprint burndown", text: "Work remaining each day of a sprint.", icon: Flame },
  { value: "velocity", label: "Velocity", text: "Points delivered per closed sprint.", icon: Gauge },
  { value: "workspace_summary", label: "Workspace summary", text: "Issue counts by status, priority and project.", icon: LayoutList },
];

const REMAINING_COLOR = "#6366f1";
const IDEAL_COLOR = "#94a3b8";
const TOOLTIP_STYLE = {
  background: "var(--tooltip-bg)",
  border: "1px solid var(--tooltip-border)",
  borderRadius: 12,
  fontSize: 12,
};
const TICK = { fontSize: 11, fill: "#94a3b8" };
const shortDate = (value: string) => format(parseISO(value), "MMM d");

export default function ReportsPage() {
  const { canEdit } = usePermissions();
  const { data: reports = [], isLoading } = useWorkspaceReports();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = reports.find((r) => r.id === selectedId) ?? reports[0] ?? null;

  return (
    <>
      <PageHeader title="Reports" description="Track sprint progress and team velocity, and export the numbers as CSV." />
      <PageBody className="space-y-5">
        {canEdit && <NewReportForm onCreated={setSelectedId} />}
        {isLoading ? (
          <Skeleton className="h-96" />
        ) : reports.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<ChartColumn className="size-6" />}
              title="No reports yet"
              description={canEdit ? "Choose a report type above to generate your first one." : "Reports your team generates will appear here."}
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
            <ul className="card max-h-[640px] divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
              {reports.map((report) => (
                <li key={report.id}>
                  <button
                    onClick={() => setSelectedId(report.id)}
                    className={cn(
                      "flex w-full cursor-pointer gap-2.5 px-4 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/50",
                      selected?.id === report.id && "bg-brand-50/70 dark:bg-brand-500/10",
                    )}
                  >
                    <Avatar user={report.requested_by} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{report.title}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                        <StateBadge state={report.state} />
                        {timeAgo(report.created_at)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {selected && <ReportDetail report={selected} />}
          </div>
        )}
      </PageBody>
    </>
  );
}

function StateBadge({ state }: { state: WorkspaceReport["state"] }) {
  const styles = {
    ready: "text-emerald-700 dark:text-emerald-400",
    pending: "text-amber-700 dark:text-amber-400",
    failed: "text-rose-700 dark:text-rose-400",
  };
  return <span className={cn("font-medium capitalize", styles[state])}>{state}</span>;
}

function NewReportForm({ onCreated }: { onCreated: (id: number) => void }) {
  const projects = (useProjects().data ?? []).filter((p) => !p.is_archived);
  const generate = useGenerateWorkspaceReport();
  const [type, setType] = useState<ReportType>("sprint_burndown");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [sprintId, setSprintId] = useState<number | null>(null);
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  const sprints = useSprints(project?.key, "active,closed").data ?? [];
  const orderedSprints = [...sprints].sort((a, b) => (b.start_date ?? "").localeCompare(a.start_date ?? ""));
  const sprint = orderedSprints.find((s) => s.id === sprintId) ?? orderedSprints[0];

  useEffect(() => setSprintId(null), [project?.id]);

  const blocked = type === "sprint_burndown" ? !sprint : type === "velocity" ? !project : false;
  const submit = () =>
    generate.mutate(
      {
        report_type: type,
        ...(type === "velocity" && { project: project?.id }),
        ...(type === "sprint_burndown" && { sprint: sprint?.id }),
      },
      {
        onSuccess: (report) => {
          onCreated(report.id);
          if (report.state === "failed") toast.error(report.error);
          else toast.success("Report queued");
        },
      },
    );

  return (
    <section className="card p-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {REPORT_TYPES.map(({ value, label, text, icon: Icon }) => (
          <button
            key={value}
            onClick={() => setType(value)}
            className={cn(
              "flex cursor-pointer gap-3 rounded-xl border p-3 text-left transition",
              type === value
                ? "border-brand-500 bg-brand-50/60 ring-4 ring-brand-500/10 dark:bg-brand-500/10"
                : "border-slate-200 hover:border-slate-300 dark:border-slate-700",
            )}
          >
            <Icon className={cn("mt-0.5 size-5 shrink-0", type === value ? "text-brand-600" : "text-slate-400")} />
            <span>
              <span className="block text-sm font-semibold">{label}</span>
              <span className="block text-xs text-slate-500">{text}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        {type !== "workspace_summary" && (
          <Field label="Project" className="w-56">
            <Select
              value={project?.id ?? null}
              onChange={setProjectId}
              options={projects.map((p) => ({ value: p.id as number | null, label: p.name, hint: p.key }))}
              placeholder="No projects"
            />
          </Field>
        )}
        {type === "sprint_burndown" && (
          <Field label="Sprint" className="w-56">
            <Select
              value={sprint?.id ?? null}
              onChange={setSprintId}
              options={orderedSprints.map((s) => ({
                value: s.id as number | null,
                label: s.name,
                hint: s.state === "active" ? "Active" : undefined,
              }))}
              placeholder="No started sprints"
            />
          </Field>
        )}
        <Button variant="primary" icon={<Plus className="size-4" />} loading={generate.isPending} disabled={blocked} onClick={submit}>
          Generate report
        </Button>
      </div>
    </section>
  );
}

function ReportDetail({ report }: { report: WorkspaceReport }) {
  const download = useDownloadReport();
  return (
    <section className="card min-w-0 p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{report.title}</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Requested by {report.requested_by?.display_name ?? "a former member"} · {timeAgo(report.created_at)}
          </p>
        </div>
        {report.state === "ready" && (
          <Button size="sm" icon={<Download className="size-4" />} loading={download.isPending} onClick={() => download.mutate(report)}>
            Download CSV
          </Button>
        )}
      </div>
      <div className="mt-5">
        {report.state === "pending" && (
          <EmptyState
            title="Generating this report"
            description="It's queued for the background worker. If it stays here, check that the Celery worker is running."
          />
        )}
        {report.state === "failed" && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {report.error || "This report couldn't be generated."}
          </p>
        )}
        {report.state === "ready" && report.report_type === "sprint_burndown" && <Burndown data={report.data as unknown as BurndownData} />}
        {report.state === "ready" && report.report_type === "velocity" && <Velocity data={report.data as unknown as VelocityData} />}
        {report.state === "ready" && report.report_type === "workspace_summary" && <Summary data={report.data as unknown as SummaryData} />}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-50 px-4 py-3 dark:bg-slate-800/60">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-0.5 text-xl font-bold">{value}</p>
    </div>
  );
}

function DataTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="mt-5 max-h-72 overflow-auto rounded-xl border border-slate-200 dark:border-slate-800">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-slate-50 text-left text-xs font-semibold text-slate-500 dark:bg-slate-800">
          <tr>{head.map((h, i) => <th key={h} className={cn("px-3 py-2", i > 0 && "text-right")}>{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => <td key={c} className={cn("px-3 py-1.5", c > 0 && "text-right tabular-nums")}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LegendItem({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="18" height="4" aria-hidden>
        <line x1="0" y1="2" x2="18" y2="2" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "4 3" : undefined} />
      </svg>
      {label}
    </span>
  );
}

function Burndown({ data }: { data: BurndownData }) {
  // Sprints with no estimates still get a useful chart, measured in issues.
  const usePoints = data.total_points > 0;
  const unit = usePoints ? "points" : "issues";
  const chart = data.days.map((d) => ({
    ...d,
    label: shortDate(d.date),
    remaining: usePoints ? d.remaining_points : d.remaining_issues,
    ideal: usePoints ? d.ideal_points : Math.round(data.total_issues * (1 - data.days.indexOf(d) / Math.max(data.days.length - 1, 1)) * 10) / 10,
  }));
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Points done" value={`${data.completed_points} / ${data.total_points}`} />
        <Stat label="Issues done" value={`${data.completed_issues} / ${data.total_issues}`} />
        <Stat label="Started" value={formatDate(data.start_date, "MMM d")} />
        <Stat label="Ends" value={formatDate(data.end_date, "MMM d")} />
      </div>
      <div className="mt-5 mb-2 flex flex-wrap gap-4 text-xs text-slate-600 dark:text-slate-400">
        <LegendItem color={REMAINING_COLOR} label={`Remaining ${unit}`} />
        <LegendItem color={IDEAL_COLOR} label="Ideal pace" dashed />
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chart} margin={{ top: 5, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
            <YAxis allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Line type="linear" dataKey="ideal" name="Ideal pace" stroke={IDEAL_COLOR} strokeWidth={2} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
            <Line type="linear" dataKey="remaining" name={`Remaining ${unit}`} stroke={REMAINING_COLOR} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <DataTable
        head={["Date", "Ideal points", "Remaining points", "Remaining issues"]}
        rows={data.days.map((d) => [shortDate(d.date), d.ideal_points, d.remaining_points ?? "—", d.remaining_issues ?? "—"])}
      />
    </>
  );
}

function Velocity({ data }: { data: VelocityData }) {
  if (data.sprints.length === 0) {
    return <EmptyState title="No closed sprints yet" description="Velocity appears once this project completes a sprint." />;
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Average velocity" value={`${data.average_points} pts`} />
        <Stat label="Closed sprints" value={data.sprints.length} />
        <Stat label="Last sprint" value={`${data.sprints[data.sprints.length - 1].completed_points} pts`} />
      </div>
      <div className="mt-5 h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.sprints} margin={{ top: 16, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="name" tick={TICK} tickLine={false} axisLine={false} />
            <YAxis allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "var(--chart-grid)", opacity: 0.4 }} />
            <ReferenceLine y={data.average_points} stroke={IDEAL_COLOR} strokeDasharray="4 3" label={{ value: "Average", position: "insideTopRight", fontSize: 11, fill: "#94a3b8" }} />
            <Bar dataKey="completed_points" name="Points delivered" fill={REMAINING_COLOR} radius={[4, 4, 0, 0]} maxBarSize={44} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <DataTable
        head={["Sprint", "Points delivered", "Issues done", "Issues left open"]}
        rows={data.sprints.map((s) => [s.name, s.completed_points, s.completed_issues, s.open_issues])}
      />
    </>
  );
}

const PRIORITY_NAMES: Record<number, string> = { 5: "Highest", 4: "High", 3: "Medium", 2: "Low", 1: "Lowest" };

function Summary({ data }: { data: SummaryData }) {
  return (
    <>
      <Stat label="Total issues" value={data.issue_count} />
      <div className="grid grid-cols-1 gap-x-4 md:grid-cols-3">
        <DataTable head={["Status", "Issues"]} rows={data.by_status.map((r) => [r.status__name, r.count])} />
        <DataTable head={["Priority", "Issues"]} rows={data.by_priority.map((r) => [PRIORITY_NAMES[r.priority] ?? r.priority, r.count])} />
        <DataTable head={["Project", "Issues"]} rows={data.projects.map((r) => [r.project__name, r.count])} />
      </div>
    </>
  );
}
