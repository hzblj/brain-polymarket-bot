'use client';

import { useState } from 'react';
import type { TimeRange } from '@/lib/api';
import {
  useSystemState,
  useMarketSnapshot,
  usePriceHistory,
  useBookHistory,
  useEvents,
} from '@/lib/hooks';
import {
  formatUsd,
  formatPct,
  formatDuration,
  formatTimeAgo,
  formatPrice,
} from '@/lib/formatters';
import { PageHeader } from '@/components/layout/page-header';
import { KpiCard } from '@/components/cards/kpi-card';
import { StatusBadge } from '@/components/badges/status-badge';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import {
  Activity,
  Droplets,
  TrendingUp,
  BookOpen,
  ShieldCheck,
  Clock,
} from 'lucide-react';

// ─── Chart theme constants ──────────────────────────────────────────────────

const CHART_COLORS = {
  accent: '#00e639',
  positive: '#00e639',
  negative: '#ef4444',
  grid: '#2e2e33',
  text: '#71717a',
} as const;

const AXIS_PROPS = {
  tick: { fill: CHART_COLORS.text, fontSize: 11 },
  axisLine: false,
  tickLine: false,
} as const;

// ─── Section wrapper ────────────────────────────────────────────────────────

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

// ─── Loading skeleton ───────────────────────────────────────────────────────

function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-surface-2 ${className}`}
    />
  );
}

function SectionSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-surface-1 p-4 space-y-3">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-[200px] w-full" />
    </div>
  );
}

// ─── Time Range Selector ────────────────────────────────────────────────────

const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '10m', label: '10m' },
  { value: '30m', label: '30m' },
];

function TimeRangeSelector({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (v: TimeRange) => void;
}) {
  return (
    <div className="flex gap-1">
      {TIME_RANGES.map((r) => (
        <button
          type="button"
          key={r.value}
          onClick={() => onChange(r.value)}
          className={`px-2 py-0.5 text-xs rounded transition-colors ${
            value === r.value
              ? 'bg-accent/20 text-accent font-medium'
              : 'bg-surface-2 text-text-muted hover:text-text-secondary'
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

// ─── Active Market Header ───────────────────────────────────────────────────

function ActiveMarketHeader() {
  const { data: system, isLoading: sysLoading } = useSystemState();
  const { data: snapshot, isLoading: snapLoading } = useMarketSnapshot();

  if (sysLoading || snapLoading) {
    return (
      <div className="flex items-center gap-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-5 w-24" />
      </div>
    );
  }

  const market = system?.activeMarket;
  const strategy = system?.currentStrategy;
  const timeToClose = snapshot?.timeToCloseMs ?? 0;

  return (
    <PageHeader
      title={market?.label ?? 'No Active Market'}
      subtitle={
        market
          ? `${market.asset} | Window ${market.windowSec}s | Closes in ${formatDuration(timeToClose)}`
          : undefined
      }
      actions={
        <div className="flex items-center gap-2">
          {strategy && (
            <span className="rounded bg-surface-2 px-2 py-0.5 text-xs text-text-secondary">
              {strategy.key} v{strategy.version}
            </span>
          )}
          <StatusBadge status={system?.wsConnected ? 'active' : 'inactive'} />
        </div>
      }
    />
  );
}

// ─── Price Panel ────────────────────────────────────────────────────────────

function PricePanel() {
  const [range, setRange] = useState<TimeRange>('5m');
  const { data: snapshot, isLoading: snapLoading } = useMarketSnapshot();
  const { data: history, isLoading: histLoading } = usePriceHistory(range);

  if (snapLoading || histLoading) return <SectionSkeleton />;

  const chartData = (history ?? []).map((pt) => ({
    ...pt,
    label: new Date(pt.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  }));

  const deltaVariant =
    (snapshot?.deltaAbs ?? 0) >= 0 ? 'positive' : 'negative';

  return (
    <Section title="Price" icon={TrendingUp}>
      <div className="flex justify-end mb-2">
        <TimeRangeSelector value={range} onChange={setRange} />
      </div>
      <div className="grid grid-cols-2 gap-4 mb-4">
        {/* BTC Price (Binance) */}
        <div>
          <p className="mb-1 text-xs text-text-muted">BTC/USD (Binance Live)</p>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke={CHART_COLORS.grid}
                vertical={false}
              />
              <XAxis dataKey="label" {...AXIS_PROPS} interval="preserveStartEnd" />
              <YAxis
                {...AXIS_PROPS}
                domain={['dataMin - 5', 'dataMax + 5']}
                tickFormatter={(v: number) => v.toFixed(0)}
                width={55}
              />
              <Tooltip
                contentStyle={{
                  background: '#111113',
                  border: '1px solid #2e2e33',
                  borderRadius: 6,
                  fontSize: 12,
                }}
                labelStyle={{ color: CHART_COLORS.text }}
                formatter={(v: number) => [`$${formatPrice(v, 2)}`, 'BTC']}
              />
              <Line
                type="monotone"
                dataKey="resolverPrice"
                stroke={CHART_COLORS.accent}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Polymarket UP/DOWN implied probability */}
        <div>
          <p className="mb-1 text-xs text-text-muted">Polymarket Implied Probability</p>
          <div className="flex items-center justify-between px-1 mb-1">
            <span className="text-xs text-positive">UP: {formatPrice(snapshot?.upBid ?? 0, 2)}/{formatPrice(snapshot?.upAsk ?? 0, 2)}</span>
            <span className="text-xs text-negative">DOWN: {formatPrice(snapshot?.downBid ?? 0, 2)}/{formatPrice(snapshot?.downAsk ?? 0, 2)}</span>
          </div>
          <div className="relative h-6 w-full rounded-full bg-surface-2 overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-positive/60 transition-all duration-500"
              style={{ width: `${((snapshot?.upBid ?? 0.5) * 100)}%` }}
            />
            <div className="absolute inset-0 flex items-center justify-center text-xs font-medium text-text-primary">
              UP {formatPct(snapshot?.upBid ?? 0)} / DOWN {formatPct(snapshot?.downBid ?? 0)}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <div className="rounded bg-surface-0/40 px-2 py-1.5">
              <span className="block text-text-muted">Spread</span>
              <span className="font-medium tabular-nums text-text-primary">{formatPrice((snapshot?.spread ?? 0) * 10000, 0)} bps</span>
            </div>
            <div className="rounded bg-surface-0/40 px-2 py-1.5">
              <span className="block text-text-muted">Momentum</span>
              <span className="font-medium tabular-nums text-text-primary">{formatPrice(snapshot?.momentum ?? 0.5, 3)}</span>
            </div>
            <div className="rounded bg-surface-0/40 px-2 py-1.5">
              <span className="block text-text-muted">Volatility</span>
              <span className="font-medium tabular-nums text-text-primary">{formatPrice((snapshot?.volatility ?? 0) * 10000, 2)} bps</span>
            </div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-5 gap-2">
        <KpiCard
          label="Start Price"
          value={formatUsd(snapshot?.startPrice ?? 0)}
        />
        <KpiCard
          label="Current Price"
          value={formatUsd(snapshot?.currentPrice ?? 0)}
        />
        <KpiCard
          label="Delta (abs)"
          value={formatUsd(snapshot?.deltaAbs ?? 0)}
          variant={deltaVariant}
        />
        <KpiCard
          label="Delta (%)"
          value={formatPct(snapshot?.deltaPct ?? 0)}
          variant={deltaVariant}
        />
        <KpiCard
          label="Volatility Mom."
          value={formatPrice(snapshot?.spotPrice ?? 0, 4)}
          icon={Activity}
        />
      </div>
    </Section>
  );
}

// ─── Order Book Panel ───────────────────────────────────────────────────────

function ImbalanceBar({ value }: { value: number }) {
  // value: -1 (all sell) to +1 (all buy), 0 = balanced
  const pct = ((value + 1) / 2) * 100;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-text-muted w-8 text-right">
        {(value * 100).toFixed(0)}%
      </span>
      <div className="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${pct}%`,
            background:
              value >= 0
                ? CHART_COLORS.positive
                : CHART_COLORS.negative,
          }}
        />
      </div>
    </div>
  );
}

function OrderBookPanel() {
  const [range, setRange] = useState<TimeRange>('5m');
  const { data: snapshot, isLoading: snapLoading } = useMarketSnapshot();
  const { data: history, isLoading: histLoading } = useBookHistory(range);

  if (snapLoading || histLoading) return <SectionSkeleton />;

  const bookChartData = (history ?? []).map((pt) => ({
    ...pt,
    label: new Date(pt.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  }));

  return (
    <Section title="Order Book" icon={BookOpen}>
      <div className="flex justify-end mb-2">
        <TimeRangeSelector value={range} onChange={setRange} />
      </div>
      {/* Stats row */}
      <div className="grid grid-cols-5 gap-2 mb-4">
        <KpiCard
          label="Best Bid (Up)"
          value={formatPrice(snapshot?.upBid ?? 0, 4)}
          variant="positive"
        />
        <KpiCard
          label="Best Ask (Up)"
          value={formatPrice(snapshot?.upAsk ?? 0, 4)}
        />
        <KpiCard
          label="Best Bid (Down)"
          value={formatPrice(snapshot?.downBid ?? 0, 4)}
        />
        <KpiCard
          label="Best Ask (Down)"
          value={formatPrice(snapshot?.downAsk ?? 0, 4)}
          variant="negative"
        />
        <KpiCard
          label="Spread"
          value={formatPrice(snapshot?.spread ?? 0, 4)}
        />
      </div>

      {/* Depth score + imbalance */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <KpiCard
          label="Depth Score"
          value={formatPrice(snapshot?.depthScore ?? 0, 2)}
        />
        <div className="rounded-lg border border-border bg-surface-0 p-3">
          <p className="text-xs text-text-muted mb-1">Imbalance</p>
          <ImbalanceBar value={snapshot?.imbalance ?? 0} />
        </div>
      </div>

      {/* Spread over time chart */}
      <p className="mb-1 text-xs text-text-muted">Spread Over Time</p>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={bookChartData}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={CHART_COLORS.grid}
            vertical={false}
          />
          <XAxis dataKey="label" {...AXIS_PROPS} interval="preserveStartEnd" />
          <YAxis
            {...AXIS_PROPS}
            domain={['auto', 'auto']}
            tickFormatter={(v: number) => v.toFixed(1)}
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
          />
          <Area
            type="monotone"
            dataKey="spread"
            stroke={CHART_COLORS.accent}
            fill={CHART_COLORS.accent}
            fillOpacity={0.1}
            strokeWidth={1.5}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Section>
  );
}

// ─── Tradeability Panel ─────────────────────────────────────────────────────

function TradeabilityItem({
  label,
  ok,
}: {
  label: string;
  ok: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded bg-surface-0 px-3 py-2">
      <span className="text-sm text-text-secondary">{label}</span>
      <span
        className={`text-xs font-medium ${ok ? 'text-positive' : 'text-negative'}`}
      >
        {ok ? 'OK' : 'FAIL'}
      </span>
    </div>
  );
}

function TradeabilityPanel() {
  const { data: snapshot, isLoading } = useMarketSnapshot();

  if (isLoading) return <SectionSkeleton />;

  const spread = snapshot?.spread ?? 1;
  const depth = snapshot?.depthScore ?? 0;
  const timeToClose = snapshot?.timeToCloseMs ?? 0;

  const spreadOk = spread < 0.04;
  const depthOk = depth > 0.5;
  const entryWindowOk = timeToClose > 30_000;
  const tradeable = spreadOk && depthOk && entryWindowOk;

  return (
    <Section title="Tradeability" icon={ShieldCheck}>
      <div className="mb-3 flex items-center gap-2">
        <div
          className={`h-3 w-3 rounded-full ${tradeable ? 'bg-positive' : 'bg-negative'}`}
        />
        <span
          className={`text-sm font-medium ${tradeable ? 'text-positive' : 'text-negative'}`}
        >
          {tradeable ? 'Tradeable' : 'Not Tradeable'}
        </span>
      </div>
      <div className="space-y-1">
        <TradeabilityItem label="Spread Status" ok={spreadOk} />
        <TradeabilityItem label="Depth Status" ok={depthOk} />
        <TradeabilityItem label="Entry Window" ok={entryWindowOk} />
      </div>
    </Section>
  );
}

// ─── Event Timeline ─────────────────────────────────────────────────────────

const severityColor: Record<string, string> = {
  info: 'border-l-accent text-text-secondary',
  warn: 'border-l-warning text-warning',
  error: 'border-l-negative text-negative',
};

function EventTimeline() {
  const { data: events, isLoading } = useEvents();

  if (isLoading) return <SectionSkeleton />;

  return (
    <Section title="Event Timeline" icon={Clock}>
      <div className="max-h-[320px] overflow-y-auto space-y-1 pr-1">
        {(events ?? []).length === 0 && (
          <p className="text-xs text-text-muted py-4 text-center">
            No recent events
          </p>
        )}
        {(events ?? []).map((evt) => (
          <div
            key={evt.id}
            className={`border-l-2 rounded bg-surface-0 px-3 py-2 ${severityColor[evt.severity] ?? severityColor.info}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">
                {evt.source} / {evt.type}
              </span>
              <span className="text-xs text-text-muted">
                {formatTimeAgo(evt.time)}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-text-secondary">
              {evt.message}
            </p>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ─── Liquidity Panel ────────────────────────────────────────────────────────

function DepthBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-muted">{label}</span>
        <span className="font-mono text-text-secondary">${formatPrice(value, 0)}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-surface-2 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function LiquidityPanel() {
  const { data: snapshot, isLoading } = useMarketSnapshot();

  if (isLoading) return <SectionSkeleton />;

  const upBidDepth = (snapshot as Record<string, unknown> | null)?.upBidDepth as number ?? 0;
  const upAskDepth = (snapshot as Record<string, unknown> | null)?.upAskDepth as number ?? 0;
  const downBidDepth = (snapshot as Record<string, unknown> | null)?.downBidDepth as number ?? 0;
  const downAskDepth = (snapshot as Record<string, unknown> | null)?.downAskDepth as number ?? 0;
  const totalDepth = (snapshot as Record<string, unknown> | null)?.totalDepthUsd as number ?? 0;
  const liquidityUsd = (snapshot as Record<string, unknown> | null)?.liquidityUsd as number ?? 0;
  const volume24h = (snapshot as Record<string, unknown> | null)?.volume24hUsd as number ?? 0;
  const microprice = (snapshot as Record<string, unknown> | null)?.microprice as number ?? 0;
  const spreadBps = (snapshot as Record<string, unknown> | null)?.spreadBps as number ?? 0;

  const maxDepth = Math.max(upBidDepth, upAskDepth, downBidDepth, downAskDepth, 1);

  return (
    <Section title="Liquidity" icon={Droplets}>
      {/* Key metrics */}
      <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
        <div className="rounded bg-surface-0/40 px-2 py-1.5">
          <span className="block text-text-muted">Pool Liquidity</span>
          <span className="font-medium tabular-nums text-accent">${formatPrice(liquidityUsd, 0)}</span>
        </div>
        <div className="rounded bg-surface-0/40 px-2 py-1.5">
          <span className="block text-text-muted">24h Volume</span>
          <span className="font-medium tabular-nums text-text-primary">${formatPrice(volume24h, 0)}</span>
        </div>
        <div className="rounded bg-surface-0/40 px-2 py-1.5">
          <span className="block text-text-muted">Total Depth</span>
          <span className="font-medium tabular-nums text-text-primary">${formatPrice(totalDepth, 0)}</span>
        </div>
        <div className="rounded bg-surface-0/40 px-2 py-1.5">
          <span className="block text-text-muted">Microprice</span>
          <span className="font-medium tabular-nums text-text-primary">{formatPrice(microprice, 4)}</span>
        </div>
      </div>

      {/* Spread */}
      <div className="rounded bg-surface-0/40 px-2 py-1.5 mb-3 text-xs">
        <span className="text-text-muted">Spread: </span>
        <span className={`font-medium tabular-nums ${spreadBps < 200 ? 'text-positive' : spreadBps < 500 ? 'text-warning' : 'text-negative'}`}>
          {formatPrice(spreadBps, 0)} bps
        </span>
      </div>

      {/* Depth bars */}
      <div className="space-y-2">
        <DepthBar label="UP Bids" value={upBidDepth} max={maxDepth} color="#00e639" />
        <DepthBar label="UP Asks" value={upAskDepth} max={maxDepth} color="#22c55e80" />
        <DepthBar label="DOWN Bids" value={downBidDepth} max={maxDepth} color="#ef4444" />
        <DepthBar label="DOWN Asks" value={downAskDepth} max={maxDepth} color="#ef444480" />
      </div>
    </Section>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function MarketPage() {
  return (
    <div className="space-y-6 p-6">
      <ActiveMarketHeader />

      <PricePanel />

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2">
          <OrderBookPanel />
        </div>
        <div className="space-y-6">
          <LiquidityPanel />
          <TradeabilityPanel />
        </div>
      </div>

      <EventTimeline />
    </div>
  );
}
