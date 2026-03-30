'use client';

import { PageHeader } from '@/components/layout/page-header';
import { KpiCard } from '@/components/cards/kpi-card';
import { useStrategyReports, useOptimizerStatus } from '@/lib/hooks';
import { formatPnl, formatPct, formatTimeAgo, formatUsd } from '@/lib/formatters';
import { useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from 'recharts';
import {
  BrainCircuit,
  TrendingUp,
  TrendingDown,
  Target,
  ShieldAlert,
  Lightbulb,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Clock,
  Activity,
  Zap,
} from 'lucide-react';
import clsx from 'clsx';

// ─── Chart theme ────────────────────────────────────────────────────────────

const CHART_COLORS = {
  positive: '#00e639',
  negative: '#ef4444',
  warning: '#f59e0b',
  grid: '#2e2e33',
  text: '#71717a',
  accent: '#00e639',
  neutral: '#6366f1',
} as const;

const AXIS_PROPS = {
  tick: { fill: CHART_COLORS.text, fontSize: 11 },
  axisLine: false,
  tickLine: false,
} as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface-2 ${className}`} />;
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-text-secondary">
        <Icon size={14} />
        {title}
      </div>
      {children}
    </section>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const styles: Record<string, string> = {
    high: 'bg-negative/10 text-negative',
    medium: 'bg-warning/10 text-warning',
    low: 'bg-surface-3 text-text-muted',
  };
  return (
    <span className={clsx('rounded-full px-2 py-0.5 text-xs font-medium', styles[priority] ?? styles.low)}>
      {priority}
    </span>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const labels: Record<string, string> = {
    risk_limits: 'Risk Limits',
    position_sizing: 'Position Sizing',
    agent_prompts: 'Agent Prompts',
    regime_filters: 'Regime Filters',
    timing: 'Timing',
    other: 'Other',
  };
  return (
    <span className="rounded bg-surface-3 px-2 py-0.5 text-xs text-text-secondary">
      {labels[category] ?? category}
    </span>
  );
}

// ─── Optimizer Status Strip ─────────────────────────────────────────────────

function OptimizerStatusStrip() {
  const { data: status, isLoading } = useOptimizerStatus();
  const { data: reports } = useStrategyReports();

  if (isLoading) {
    return (
      <div className="grid grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }

  const latest = reports?.[0];
  const intervalHours = status ? Math.round(status.intervalMs / 3600000) : 24;

  return (
    <div className="grid grid-cols-5 gap-3">
      <KpiCard
        label="Scheduler"
        value={status?.enabled ? 'Active' : 'Disabled'}
        variant={status?.enabled ? 'positive' : 'default'}
        icon={Clock}
      />
      <KpiCard
        label="Interval"
        value={`${intervalHours}h`}
        icon={Activity}
      />
      <KpiCard
        label="Last Run"
        value={status?.lastRunAt ? formatTimeAgo(status.lastRunAt) : 'Never'}
        icon={BrainCircuit}
      />
      <KpiCard
        label="Today P&L"
        value={latest ? formatPnl(latest.totalPnlUsd) : '--'}
        variant={latest && latest.totalPnlUsd >= 0 ? 'positive' : latest ? 'negative' : 'default'}
        icon={latest && latest.totalPnlUsd >= 0 ? TrendingUp : TrendingDown}
      />
      <KpiCard
        label="Reports"
        value={String(reports?.length ?? 0)}
        icon={BrainCircuit}
      />
    </div>
  );
}

// ─── Regime Performance Chart ───────────────────────────────────────────────

function RegimePerformanceChart({
  data,
}: {
  data: Record<string, { trades: number; pnlUsd: number; winRate: number }>;
}) {
  const chartData = Object.entries(data).map(([regime, stats]) => ({
    regime,
    pnl: stats.pnlUsd,
    winRate: stats.winRate,
    trades: stats.trades,
  }));

  if (chartData.length === 0) {
    return <p className="text-xs text-text-muted text-center py-8">No regime data</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
        <XAxis dataKey="regime" {...AXIS_PROPS} />
        <YAxis {...AXIS_PROPS} tickFormatter={(v: number) => `$${v}`} width={50} />
        <Tooltip
          contentStyle={{
            background: '#111113',
            border: '1px solid #2e2e33',
            borderRadius: 6,
            fontSize: 12,
          }}
          labelStyle={{ color: CHART_COLORS.text }}
          formatter={(v: number, name: string) => {
            if (name === 'pnl') return [formatPnl(v), 'P&L'];
            return [v, name];
          }}
        />
        <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
          {chartData.map((entry, idx) => (
            <Cell
              key={idx}
              fill={entry.pnl >= 0 ? CHART_COLORS.positive : CHART_COLORS.negative}
              fillOpacity={0.7}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Report Detail (expandable) ─────────────────────────────────────────────

function ReportCard({
  report,
}: {
  report: NonNullable<ReturnType<typeof useStrategyReports>['data']>[number];
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-surface-1 overflow-hidden">
      {/* Summary */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-4 px-4 py-3 text-left hover:bg-surface-2/30 transition-colors"
      >
        <span className="text-xs text-text-muted">
          {new Date(report.periodStart).toLocaleDateString()}
        </span>
        <span className="text-xs text-text-secondary tabular-nums">{report.totalTrades} trades</span>
        <span
          className={clsx(
            'text-sm font-medium tabular-nums',
            report.totalPnlUsd >= 0 ? 'text-positive' : 'text-negative',
          )}
        >
          {formatPnl(report.totalPnlUsd)}
        </span>
        <span className="text-xs text-text-muted tabular-nums">
          WR: {formatPct(report.winRate)}
        </span>
        <span className="text-xs text-text-muted tabular-nums">
          DD: {formatUsd(report.maxDrawdownUsd)}
        </span>
        <span className="text-xs text-accent tabular-nums">
          {report.suggestions.length} suggestions
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs text-text-muted">
          {formatTimeAgo(report.createdAt)}
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {/* Expanded */}
      {expanded && (
        <div className="border-t border-border px-4 py-4 space-y-4 bg-surface-0">
          {/* Executive Summary */}
          <div className="rounded bg-accent/5 border border-accent/20 p-3">
            <p className="text-sm text-text-primary leading-relaxed">{report.executiveSummary}</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Regime Performance */}
            <Section title="P&L by Regime" icon={Activity}>
              <RegimePerformanceChart data={report.performanceByRegime} />
            </Section>

            {/* Agent Accuracy */}
            <Section title="Agent Accuracy" icon={Target}>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">Edge Prediction</span>
                  <span className="text-sm font-medium tabular-nums text-text-primary">
                    {formatPct(report.agentAccuracy.edgePredictionAccuracy)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">Confidence Calibration</span>
                  <span className="text-sm font-medium tabular-nums text-text-primary">
                    {formatPct(report.agentAccuracy.confidenceCalibration)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">Risk Rejection Rate</span>
                  <span className="text-sm font-medium tabular-nums text-text-primary">
                    {formatPct(report.riskMetrics.rejectionRate)}
                  </span>
                </div>
                {report.riskMetrics.topRejectionReasons.length > 0 && (
                  <div className="pt-2 border-t border-border">
                    <div className="text-xs text-text-muted mb-1">Top Rejection Reasons</div>
                    {report.riskMetrics.topRejectionReasons.map((r, i) => (
                      <div key={i} className="text-xs text-text-secondary font-mono">
                        {r}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Section>
          </div>

          {/* Patterns */}
          {report.patterns.length > 0 && (
            <Section title="Detected Patterns" icon={AlertTriangle}>
              <ul className="space-y-1">
                {report.patterns.map((p, i) => (
                  <li key={i} className="text-xs text-text-secondary flex items-start gap-2">
                    <Zap size={12} className="text-warning mt-0.5 shrink-0" />
                    {p}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Suggestions */}
          {report.suggestions.length > 0 && (
            <Section title="Strategy Suggestions" icon={Lightbulb}>
              <div className="space-y-2">
                {report.suggestions.map((s, i) => (
                  <div key={i} className="rounded bg-surface-2/50 p-3 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <PriorityBadge priority={s.priority} />
                      <CategoryBadge category={s.category} />
                      <span className="text-xs text-text-muted tabular-nums ml-auto">
                        {(s.confidence * 100).toFixed(0)}% confidence
                      </span>
                      {s.autoApplicable && (
                        <span className="rounded bg-accent/10 text-accent px-1.5 py-0.5 text-xs">
                          auto-applicable
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-text-primary font-medium">{s.suggestion}</p>
                    <p className="text-xs text-text-secondary">{s.rationale}</p>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Report List ────────────────────────────────────────────────────────────

function ReportList() {
  const { data: reports, isLoading } = useStrategyReports();

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    );
  }

  const all = reports ?? [];

  if (all.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-border bg-surface-1 p-12">
        <p className="text-text-muted text-sm">No strategy reports yet. Reports generate automatically every 24h or on demand.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {all.map((r) => (
        <ReportCard key={r.id} report={r} />
      ))}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function StrategyReportsPage() {
  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Strategy Reports"
        subtitle="Daily deep analysis: regime performance, agent accuracy, strategy optimization suggestions"
      />

      <OptimizerStatusStrip />
      <ReportList />
    </div>
  );
}
