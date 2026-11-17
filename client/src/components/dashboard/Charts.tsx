import type * as React from 'react';
import { useEffect, useState } from 'react';
import { animate, motion } from 'framer-motion';
import { ArrowDownRight, ArrowUpRight, Table2 } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useTheme } from '../../store/theme';
import { cn, compactMoney, compactNumber, formatDate } from '../../lib/format';
import { Segmented } from '../ui/Controls';

/** Chart roles per theme. Series hue validated for contrast/lightness on both card surfaces. */
export function useChartColors() {
  const theme = useTheme((s) => s.theme);
  return theme === 'dark'
    ? { series: '#7458fb', grid: '#24242e', axis: '#71717a', cursor: '#3f3f46', surface: '#12121a' }
    : { series: '#6236f1', grid: '#ececf1', axis: '#a1a1aa', cursor: '#d4d4d8', surface: '#ffffff' };
}

interface CountUpProps {
  value?: any;
  format?: any;
}

function CountUp({ value, format }: CountUpProps) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    const controls = animate(0, Number(value) || 0, { duration: 1.1, ease: 'easeOut', onUpdate: setDisplay });
    return () => controls.stop();
  }, [value]);
  return <>{format(display)}</>;
}

/** Stat tile: label · value · delta vs the previous period (colour = direction × whether up is good). */
interface StatCardProps {
  label?: React.ReactNode;
  value?: any;
  change?: any;
  format?: any;
  icon?: React.ElementType;
  hint?: React.ReactNode;
  upIsGood?: any;
  index?: any;
}

export function StatCard({ label, value, change, format = (n) => compactNumber(Math.round(n)), icon: Icon, hint, upIsGood = true, index = 0 }: StatCardProps) {
  const hasChange = change !== undefined && change !== null;
  const positive = change >= 0;
  const good = positive === upIsGood;
  return (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06 }} className="card relative overflow-hidden p-5">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium muted">{label}</p>
        {Icon && (
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
            <Icon className="h-5 w-5" />
          </div>
        )}
      </div>
      <p className="mt-1 font-display text-3xl font-bold tracking-tight">
        <CountUp value={value} format={format} />
      </p>
      <div className="mt-2 flex items-center gap-2 text-xs">
        {hasChange && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-semibold',
              good ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300' : 'bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300',
            )}
          >
            {positive ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
            {positive ? '+' : ''}
            {change.toFixed(1)}%
          </span>
        )}
        {hint && <span className="muted">{hint}</span>}
      </div>
    </motion.div>
  );
}

const shortDate = (key) => (key.length === 7 ? new Date(`${key}-01`).toLocaleDateString('en-IN', { month: 'short' }) : formatDate(key, { year: undefined }));

interface ChartTooltipProps {
  active?: any;
  payload?: any;
  label?: string;
  metric?: any;
}

function ChartTooltip({ active, payload, label, metric }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs shadow-xl dark:border-white/10 dark:bg-surface-dark-2">
      <p className="mb-1 font-medium muted">{label.length === 7 ? new Date(`${label}-01`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : formatDate(label)}</p>
      <p className="flex items-center gap-2 font-semibold text-zinc-900 dark:text-zinc-100">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: payload[0].color || payload[0].fill }} />
        {metric.label}: {metric.format(payload[0].value)}
      </p>
    </div>
  );
}

/**
 * One-series time chart with a metric toggle (never two y-axes): area for money, columns for counts.
 * Includes crosshair tooltip and a table view for accessibility.
 */
interface TrendChartProps {
  data?: any;
  metrics?: any;
  title?: React.ReactNode;
  subtitle?: any;
  height?: any;
}

export function TrendChart({ data, metrics, title, subtitle, height = 300 }: TrendChartProps) {
  const [key, setKey] = useState(metrics[0].key);
  const [table, setTable] = useState(false);
  const colors = useChartColors();
  const metric = metrics.find((m) => m.key === key);
  const total = data.reduce((s, d) => s + (d[key] || 0), 0);

  const axisProps = { stroke: colors.axis, tickLine: false, axisLine: false, fontSize: 11 };
  const common = { data, margin: { top: 8, right: 8, left: 0, bottom: 0 } };

  return (
    <div className="card p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-semibold">{title}</p>
          <p className="text-xs muted">{subtitle}</p>
          <p className="mt-2 font-display text-2xl font-bold">{metric.format(total)}</p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented size="sm" value={key} onChange={setKey} options={metrics.map((m) => ({ value: m.key, label: m.label }))} />
          <button type="button" onClick={() => setTable((t) => !t)} className={cn('btn-icon h-8 w-8', table && 'bg-zinc-100 dark:bg-white/10')} aria-label="Toggle table view" title="Table view">
            <Table2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="mt-4" style={{ height }}>
        {table ? (
          <div className="h-full overflow-y-auto rounded-xl border border-zinc-100 dark:border-white/5">
            <table className="table-base">
              <thead>
                <tr><th>Date</th><th className="text-right">{metric.label}</th></tr>
              </thead>
              <tbody>
                {[...data].reverse().map((d) => (
                  <tr key={d.date}><td>{shortDate(d.date)}</td><td className="text-right tabular-nums">{metric.format(d[key])}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {metric.kind === 'count' ? (
              <BarChart {...common}>
                <CartesianGrid vertical={false} stroke={colors.grid} />
                <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={24} {...axisProps} />
                <YAxis width={44} allowDecimals={false} tickFormatter={(v) => compactNumber(v)} {...axisProps} />
                <Tooltip cursor={{ fill: colors.cursor, opacity: 0.25 }} content={<ChartTooltip metric={metric} />} />
                <Bar dataKey={key} fill={colors.series} radius={[4, 4, 0, 0]} maxBarSize={24} animationDuration={700} />
              </BarChart>
            ) : (
              <AreaChart {...common}>
                <defs>
                  <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colors.series} stopOpacity={0.18} />
                    <stop offset="100%" stopColor={colors.series} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke={colors.grid} />
                <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={24} {...axisProps} />
                <YAxis width={52} tickFormatter={(v) => compactMoney(v)} {...axisProps} />
                <Tooltip cursor={{ stroke: colors.cursor, strokeWidth: 1 }} content={<ChartTooltip metric={metric} />} />
                <Area
                  type="monotone"
                  dataKey={key}
                  stroke={colors.series}
                  strokeWidth={2}
                  fill="url(#trend-fill)"
                  activeDot={{ r: 5, strokeWidth: 2, stroke: colors.surface }}
                  animationDuration={800}
                />
              </AreaChart>
            )}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

/** Ranked horizontal bars (magnitude, one hue) with the value at each bar's tip. */
interface BarListProps {
  items?: any;
  format?: any;
  emptyLabel?: any;
}

export function BarList({ items, format, emptyLabel = 'No data yet' }: BarListProps) {
  const colors = useChartColors();
  const max = Math.max(...items.map((i) => i.value), 1);
  if (!items.length) return <p className="py-8 text-center text-sm muted">{emptyLabel}</p>;
  return (
    <ul className="space-y-3">
      {items.map((item, i) => (
        <li key={item.label} className="group" title={`${item.label}: ${format(item.value)}`}>
          <div className="mb-1 flex items-center justify-between gap-3 text-sm">
            <span className="truncate font-medium">{item.label}</span>
            <span className="shrink-0 font-semibold tabular-nums">{format(item.value)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-white/[0.06]">
            <motion.div
              className="h-full rounded-full transition-[filter] group-hover:brightness-110"
              style={{ background: colors.series }}
              initial={{ width: 0 }}
              whileInView={{ width: `${(item.value / max) * 100}%` }}
              viewport={{ once: true }}
              transition={{ duration: 0.8, delay: i * 0.05, ease: 'easeOut' }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
