'use client';

import { PageHeader } from '@/components/layout/page-header';
import { KpiCard } from '@/components/cards/kpi-card';
import { useWhaleFeatures, useWhaleTransactions, useWhaleHistory } from '@/lib/hooks';
import { formatPrice, formatTimeAgo } from '@/lib/formatters';
import {
  AreaChart,
  Area,
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
  Waves,
  ArrowUpRight,
  ArrowDownLeft,
  Activity,
  AlertTriangle,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';

// ─── Chart theme ────────────────────────────────────────────────────────────

const CHART_COLORS = {
  accent: '#00e639',
  positive: '#00e639',
  negative: '#ef4444',
  warning: '#f59e0b',
  grid: '#2e2e33',
  text: '#71717a',
  inflow: '#ef4444',
  outflow: '#00e639',
  neutral: '#6366f1',
} as const;

const AXIS_PROPS = {
  tick: { fill: CHART_COLORS.text, fontSize: 11 },
  axisLine: false,
  tickLine: false,
} as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface-2 ${className}`} />;
}

function SectionSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-surface-1 p-4 space-y-3">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-[200px] w-full" />
    </div>
  );
}

function shortenAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ─── Flow Pressure Gauge ────────────────────────────────────────────────────

function FlowPressureGauge({ value }: { value: number }) {
  // value: -1 (strong outflow/bullish) to +1 (strong inflow/bearish)
  const pct = ((value + 1) / 2) * 100;
  const label =
    value > 0.3 ? 'Bearish' : value < -0.3 ? 'Bullish' : 'Neutral';
  const color =
    value > 0.3
      ? CHART_COLORS.negative
      : value < -0.3
        ? CHART_COLORS.positive
        : CHART_COLORS.neutral;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-muted">Outflow (Bullish)</span>
        <span className="font-medium" style={{ color }}>
          {label}
        </span>
        <span className="text-text-muted">Inflow (Bearish)</span>
      </div>
      <div className="relative h-3 w-full rounded-full bg-surface-2 overflow-hidden">
        {/* Center marker */}
        <div className="absolute left-1/2 top-0 h-full w-px bg-text-muted/30" />
        {/* Fill */}
        <div
          className="absolute top-0 h-full rounded-full transition-all duration-500"
          style={{
            left: value >= 0 ? '50%' : `${pct}%`,
            width: `${Math.abs(value) * 50}%`,
            background: color,
            opacity: 0.7,
          }}
        />
      </div>
      <div className="text-center text-xs tabular-nums text-text-secondary">
        {value >= 0 ? '+' : ''}
        {(value * 100).toFixed(1)}%
      </div>
    </div>
  );
}

// ─── KPI Strip ──────────────────────────────────────────────────────────────

function WhaleKpis() {
  const { data: features, isLoading } = useWhaleFeatures();

  if (isLoading) {
    return (
      <div className="grid grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }

  const abnormalVariant =
    (features?.abnormalActivityScore ?? 0) > 0.7
      ? 'negative'
      : (features?.abnormalActivityScore ?? 0) > 0.4
        ? 'warning'
        : 'default';

  return (
    <div className="grid grid-cols-5 gap-3">
      <KpiCard
        label="Large Txs (5m)"
        value={String(features?.largeTransactionCount ?? 0)}
        icon={Activity}
      />
      <KpiCard
        label="Whale Volume"
        value={`${formatPrice(features?.whaleVolumeBtc ?? 0, 2)} BTC`}
        icon={Waves}
      />
      <KpiCard
        label="Net Exchange Flow"
        value={`${(features?.netExchangeFlowBtc ?? 0) >= 0 ? '+' : ''}${formatPrice(features?.netExchangeFlowBtc ?? 0, 2)} BTC`}
        variant={
          (features?.netExchangeFlowBtc ?? 0) > 0.5
            ? 'negative'
            : (features?.netExchangeFlowBtc ?? 0) < -0.5
              ? 'positive'
              : 'default'
        }
        icon={(features?.netExchangeFlowBtc ?? 0) >= 0 ? TrendingDown : TrendingUp}
      />
      <KpiCard
        label="Flow Pressure"
        value={`${((features?.exchangeFlowPressure ?? 0) * 100).toFixed(1)}%`}
      />
      <KpiCard
        label="Abnormal Activity"
        value={`${((features?.abnormalActivityScore ?? 0) * 100).toFixed(0)}%`}
        variant={abnormalVariant as 'positive' | 'negative' | 'warning' | undefined}
        icon={AlertTriangle}
      />
    </div>
  );
}

// ─── Flow Pressure Panel ────────────────────────────────────────────────────

function FlowPressurePanel() {
  const { data: features, isLoading: featLoading } = useWhaleFeatures();
  const { data: history, isLoading: histLoading } = useWhaleHistory();

  if (featLoading || histLoading) return <SectionSkeleton />;

  const chartData = (history ?? []).map((pt) => ({
    time: new Date(pt.eventTime).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
    pressure: pt.features.exchangeFlowPressure * 100,
    volume: pt.features.whaleVolumeBtc,
  }));

  return (
    <Section title="Exchange Flow Pressure" icon={Waves}>
      <FlowPressureGauge value={features?.exchangeFlowPressure ?? 0} />

      <p className="mt-4 mb-1 text-xs text-text-muted">Flow Pressure Over Time</p>
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
          <XAxis dataKey="time" {...AXIS_PROPS} interval="preserveStartEnd" />
          <YAxis
            {...AXIS_PROPS}
            domain={[-100, 100]}
            tickFormatter={(v: number) => `${v}%`}
            width={45}
          />
          <Tooltip
            contentStyle={{
              background: '#111113',
              border: '1px solid #2e2e33',
              borderRadius: 6,
              fontSize: 12,
            }}
            labelStyle={{ color: CHART_COLORS.text }}
            formatter={(v: number) => [`${v.toFixed(1)}%`, 'Pressure']}
          />
          {/* Reference line at 0 */}
          <Area
            type="monotone"
            dataKey="pressure"
            stroke={CHART_COLORS.accent}
            fill={CHART_COLORS.accent}
            fillOpacity={0.15}
            strokeWidth={1.5}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Section>
  );
}

// ─── Whale Volume Panel ─────────────────────────────────────────────────────

function WhaleVolumePanel() {
  const { data: history, isLoading } = useWhaleHistory();

  if (isLoading) return <SectionSkeleton />;

  const chartData = (history ?? []).map((pt) => ({
    time: new Date(pt.eventTime).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    }),
    volume: pt.features.whaleVolumeBtc,
    abnormal: pt.features.abnormalActivityScore,
  }));

  return (
    <Section title="Whale Volume" icon={Activity}>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
          <XAxis dataKey="time" {...AXIS_PROPS} interval="preserveStartEnd" />
          <YAxis
            {...AXIS_PROPS}
            tickFormatter={(v: number) => `${v.toFixed(0)}`}
            width={40}
          />
          <Tooltip
            contentStyle={{
              background: '#111113',
              border: '1px solid #2e2e33',
              borderRadius: 6,
              fontSize: 12,
            }}
            labelStyle={{ color: CHART_COLORS.text }}
            formatter={(v: number, name: string) => [
              name === 'volume' ? `${v.toFixed(2)} BTC` : `${(v * 100).toFixed(0)}%`,
              name === 'volume' ? 'Volume' : 'Abnormality',
            ]}
          />
          <Bar dataKey="volume" radius={[3, 3, 0, 0]}>
            {chartData.map((entry, idx) => (
              <Cell
                key={idx}
                fill={
                  entry.abnormal > 0.7
                    ? CHART_COLORS.negative
                    : entry.abnormal > 0.4
                      ? CHART_COLORS.warning
                      : CHART_COLORS.accent
                }
                fillOpacity={0.7}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Section>
  );
}

// ─── Recent Transactions Panel ──────────────────────────────────────────────

function DirectionIcon({ direction }: { direction: string }) {
  if (direction === 'exchange_inflow') {
    return <ArrowDownLeft size={14} className="text-negative" />;
  }
  if (direction === 'exchange_outflow') {
    return <ArrowUpRight size={14} className="text-positive" />;
  }
  return <Activity size={14} className="text-text-muted" />;
}

function directionLabel(direction: string): string {
  if (direction === 'exchange_inflow') return 'Exchange Inflow';
  if (direction === 'exchange_outflow') return 'Exchange Outflow';
  return 'Unknown';
}

function RecentTransactionsPanel() {
  const { data: transactions, isLoading } = useWhaleTransactions();

  if (isLoading) return <SectionSkeleton />;

  const txs = transactions ?? [];

  return (
    <Section title="Recent Whale Transactions" icon={Waves}>
      <div className="max-h-[400px] overflow-y-auto space-y-1 pr-1">
        {txs.length === 0 && (
          <p className="text-xs text-text-muted py-8 text-center">
            No whale transactions detected in the current window
          </p>
        )}
        {txs.map((tx) => (
          <div
            key={tx.txid}
            className="flex items-center gap-3 rounded bg-surface-0 px-3 py-2"
          >
            <DirectionIcon direction={tx.direction} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-primary tabular-nums">
                  {formatPrice(tx.amountBtc, 2)} BTC
                </span>
                <span className="text-xs text-text-muted">
                  ${formatPrice(tx.amountUsd, 0)}
                </span>
              </div>
              <div className="flex items-center justify-between mt-0.5">
                <span
                  className={`text-xs ${
                    tx.direction === 'exchange_inflow'
                      ? 'text-negative'
                      : tx.direction === 'exchange_outflow'
                        ? 'text-positive'
                        : 'text-text-muted'
                  }`}
                >
                  {directionLabel(tx.direction)}
                </span>
                <span className="text-xs text-text-muted">
                  {formatTimeAgo(new Date(tx.eventTime).toISOString())}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-text-muted font-mono truncate">
                {shortenAddress(tx.fromAddress)} → {shortenAddress(tx.toAddress)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function WhalesPage() {
  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Whale Tracker"
        subtitle="On-chain BTC whale activity & exchange flow monitoring (mempool.space)"
      />

      <WhaleKpis />

      <div className="grid grid-cols-2 gap-6">
        <FlowPressurePanel />
        <WhaleVolumePanel />
      </div>

      <RecentTransactionsPanel />
    </div>
  );
}
