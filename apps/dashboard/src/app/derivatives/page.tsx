'use client';

import { PageHeader } from '@/components/layout/page-header';
import { KpiCard } from '@/components/cards/kpi-card';
import {
  useDerivativesFeatures,
  useDerivativesLiquidations,
  useDerivativesHistory,
} from '@/lib/hooks';
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
  ReferenceLine,
} from 'recharts';
import {
  Flame,
  TrendingUp,
  TrendingDown,
  Activity,
  Zap,
  DollarSign,
  Gauge,
} from 'lucide-react';

const CHART_COLORS = {
  accent: '#00e639',
  positive: '#00e639',
  negative: '#ef4444',
  warning: '#f59e0b',
  grid: '#2e2e33',
  text: '#71717a',
  purple: '#8b5cf6',
  blue: '#3b82f6',
} as const;

const AXIS_PROPS = {
  tick: { fill: CHART_COLORS.text, fontSize: 11 },
  axisLine: false,
  tickLine: false,
} as const;

function Section({
  title,
  icon: Icon,
  children,
}: { title: string; icon: React.ElementType; children: React.ReactNode }) {
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

// ─── Sentiment Gauge ────────────────────────────────────────────────────────

function SentimentGauge({ value }: { value: number }) {
  const label =
    value > 0.3 ? 'Bullish' : value < -0.3 ? 'Bearish' : 'Neutral';
  const color =
    value > 0.3 ? CHART_COLORS.positive : value < -0.3 ? CHART_COLORS.negative : CHART_COLORS.blue;
  const pct = ((value + 1) / 2) * 100;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-muted">Bearish</span>
        <span className="font-semibold text-sm" style={{ color }}>{label}</span>
        <span className="text-text-muted">Bullish</span>
      </div>
      <div className="relative h-4 w-full rounded-full bg-surface-2 overflow-hidden">
        <div className="absolute left-1/2 top-0 h-full w-px bg-text-muted/40" />
        <div
          className="absolute top-0.5 h-3 w-3 rounded-full transition-all duration-500 -translate-x-1/2"
          style={{ left: `${pct}%`, background: color, boxShadow: `0 0 8px ${color}60` }}
        />
      </div>
    </div>
  );
}

// ─── KPI Strip ──────────────────────────────────────────────────────────────

function DerivativesKpis() {
  const { data: f, isLoading } = useDerivativesFeatures();

  if (isLoading) {
    return (
      <div className="grid grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
      </div>
    );
  }

  const fundingPct = ((f?.fundingRate ?? 0) * 100).toFixed(4);
  const fundingAnnPct = ((f?.fundingRateAnnualized ?? 0) * 100).toFixed(1);
  const fundingVariant =
    (f?.fundingPressure ?? 0) > 0.3 ? 'negative' : (f?.fundingPressure ?? 0) < -0.3 ? 'positive' : 'default';

  return (
    <div className="grid grid-cols-6 gap-3">
      <KpiCard
        label="Funding Rate"
        value={`${fundingPct}%`}
        variant={fundingVariant as 'positive' | 'negative' | undefined}
        icon={(f?.fundingRate ?? 0) >= 0 ? TrendingUp : TrendingDown}
      />
      <KpiCard
        label="Funding (Annual)"
        value={`${fundingAnnPct}%`}
        variant={fundingVariant as 'positive' | 'negative' | undefined}
      />
      <KpiCard
        label="Open Interest"
        value={`$${formatPrice((f?.openInterestUsd ?? 0) / 1e9, 2)}B`}
        icon={DollarSign}
      />
      <KpiCard
        label="OI Change"
        value={`${(f?.openInterestChangePct ?? 0) >= 0 ? '+' : ''}${formatPrice(f?.openInterestChangePct ?? 0, 2)}%`}
        variant={(f?.openInterestChangePct ?? 0) > 1 ? 'positive' : (f?.openInterestChangePct ?? 0) < -1 ? 'negative' : 'default'}
      />
      <KpiCard
        label="Long Liqs (5m)"
        value={`$${formatPrice((f?.longLiquidationUsd ?? 0) / 1000, 0)}K`}
        variant={(f?.longLiquidationUsd ?? 0) > 500_000 ? 'negative' : 'default'}
        icon={Zap}
      />
      <KpiCard
        label="Short Liqs (5m)"
        value={`$${formatPrice((f?.shortLiquidationUsd ?? 0) / 1000, 0)}K`}
        variant={(f?.shortLiquidationUsd ?? 0) > 500_000 ? 'positive' : 'default'}
        icon={Zap}
      />
    </div>
  );
}

// ─── Sentiment Panel ────────────────────────────────────────────────────────

function SentimentPanel() {
  const { data: f, isLoading: fLoading } = useDerivativesFeatures();
  const { data: history, isLoading: hLoading } = useDerivativesHistory();

  if (fLoading || hLoading) return <SectionSkeleton />;

  const chartData = (history ?? []).map((pt) => ({
    time: new Date(pt.eventTime).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }),
    sentiment: pt.features.derivativesSentiment * 100,
    funding: pt.features.fundingPressure * 100,
    liqIntensity: pt.features.liquidationIntensity * 100,
  }));

  return (
    <Section title="Derivatives Sentiment" icon={Gauge}>
      <SentimentGauge value={f?.derivativesSentiment ?? 0} />

      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div className="rounded bg-surface-0/40 px-2 py-1.5">
          <span className="block text-text-muted">Funding Signal</span>
          <span className="font-medium tabular-nums">{((f?.fundingPressure ?? 0) * -100).toFixed(1)}%</span>
        </div>
        <div className="rounded bg-surface-0/40 px-2 py-1.5">
          <span className="block text-text-muted">OI Trend</span>
          <span className="font-medium tabular-nums">{((f?.oiTrend ?? 0) * 100).toFixed(1)}%</span>
        </div>
        <div className="rounded bg-surface-0/40 px-2 py-1.5">
          <span className="block text-text-muted">Liq Intensity</span>
          <span className={`font-medium tabular-nums ${(f?.liquidationIntensity ?? 0) > 0.5 ? 'text-warning' : ''}`}>
            {((f?.liquidationIntensity ?? 0) * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      <p className="mt-4 mb-1 text-xs text-text-muted">Sentiment Over Time</p>
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
          <XAxis dataKey="time" {...AXIS_PROPS} interval="preserveStartEnd" />
          <YAxis {...AXIS_PROPS} domain={[-100, 100]} tickFormatter={(v: number) => `${v}%`} width={45} />
          <Tooltip
            contentStyle={{ background: '#111113', border: '1px solid #2e2e33', borderRadius: 6, fontSize: 12 }}
            labelStyle={{ color: CHART_COLORS.text }}
          />
          <ReferenceLine y={0} stroke={CHART_COLORS.text} strokeDasharray="3 3" strokeOpacity={0.5} />
          <Area type="monotone" dataKey="sentiment" stroke={CHART_COLORS.purple} fill={CHART_COLORS.purple} fillOpacity={0.15} strokeWidth={1.5} name="Sentiment" />
        </AreaChart>
      </ResponsiveContainer>
    </Section>
  );
}

// ─── Liquidation Feed ───────────────────────────────────────────────────────

function LiquidationFeed() {
  const { data: liqs, isLoading } = useDerivativesLiquidations();
  const { data: history, isLoading: hLoading } = useDerivativesHistory();

  if (isLoading || hLoading) return <SectionSkeleton />;

  const chartData = (history ?? []).map((pt) => ({
    time: new Date(pt.eventTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    longs: pt.features.longLiquidationUsd / 1000,
    shorts: pt.features.shortLiquidationUsd / 1000,
  }));

  return (
    <Section title="Liquidations" icon={Zap}>
      {/* Stacked bar chart */}
      <p className="mb-1 text-xs text-text-muted">Long vs Short Liquidations ($K)</p>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
          <XAxis dataKey="time" {...AXIS_PROPS} interval="preserveStartEnd" />
          <YAxis {...AXIS_PROPS} tickFormatter={(v: number) => `${v.toFixed(0)}K`} width={45} />
          <Tooltip
            contentStyle={{ background: '#111113', border: '1px solid #2e2e33', borderRadius: 6, fontSize: 12 }}
            labelStyle={{ color: CHART_COLORS.text }}
            formatter={(v: number, name: string) => [`$${v.toFixed(0)}K`, name === 'longs' ? 'Long Liqs' : 'Short Liqs']}
          />
          <Bar dataKey="longs" stackId="a" fill={CHART_COLORS.negative} fillOpacity={0.7} radius={[0, 0, 0, 0]} name="longs" />
          <Bar dataKey="shorts" stackId="a" fill={CHART_COLORS.positive} fillOpacity={0.7} radius={[3, 3, 0, 0]} name="shorts" />
        </BarChart>
      </ResponsiveContainer>

      {/* Recent liquidation events */}
      <p className="mt-3 mb-1 text-xs text-text-muted">Recent Events</p>
      <div className="max-h-[250px] overflow-y-auto space-y-1 pr-1">
        {(liqs ?? []).length === 0 && (
          <p className="text-xs text-text-muted py-4 text-center">No significant liquidations in the current window</p>
        )}
        {(liqs ?? []).map((liq, idx) => (
          <div key={idx} className="flex items-center gap-3 rounded bg-surface-0 px-3 py-2">
            <Zap
              size={14}
              className={liq.side === 'sell' ? 'text-negative' : 'text-positive'}
            />
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-primary">
                  {liq.side === 'sell' ? 'Long Liquidated' : 'Short Liquidated'}
                </span>
                <span className="text-xs text-text-muted">
                  {formatTimeAgo(new Date(liq.eventTime).toISOString())}
                </span>
              </div>
              <div className="flex items-center justify-between mt-0.5">
                <span className="text-xs tabular-nums text-text-secondary">
                  {formatPrice(liq.quantity, 3)} BTC @ ${formatPrice(liq.price, 0)}
                </span>
                <span className={`text-xs font-medium tabular-nums ${liq.quantityUsd > 500_000 ? 'text-warning' : 'text-text-secondary'}`}>
                  ${formatPrice(liq.quantityUsd / 1000, 0)}K
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ─── Funding Rate History ───────────────────────────────────────────────────

function FundingRatePanel() {
  const { data: history, isLoading } = useDerivativesHistory();

  if (isLoading) return <SectionSkeleton />;

  const chartData = (history ?? []).map((pt) => ({
    time: new Date(pt.eventTime).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit',
    }),
    funding: pt.features.fundingPressure * 100,
    oiTrend: pt.features.oiTrend * 100,
  }));

  return (
    <Section title="Funding Pressure History" icon={TrendingUp}>
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
          <XAxis dataKey="time" {...AXIS_PROPS} interval="preserveStartEnd" />
          <YAxis {...AXIS_PROPS} domain={[-100, 100]} tickFormatter={(v: number) => `${v}%`} width={45} />
          <Tooltip
            contentStyle={{ background: '#111113', border: '1px solid #2e2e33', borderRadius: 6, fontSize: 12 }}
            labelStyle={{ color: CHART_COLORS.text }}
            formatter={(v: number, name: string) => [`${v.toFixed(1)}%`, name === 'funding' ? 'Funding Pressure' : 'OI Trend']}
          />
          <ReferenceLine y={0} stroke={CHART_COLORS.text} strokeDasharray="3 3" strokeOpacity={0.5} />
          <Area type="monotone" dataKey="funding" stroke={CHART_COLORS.warning} fill={CHART_COLORS.warning} fillOpacity={0.1} strokeWidth={1.5} name="funding" />
          <Area type="monotone" dataKey="oiTrend" stroke={CHART_COLORS.blue} fill={CHART_COLORS.blue} fillOpacity={0.1} strokeWidth={1.5} name="oiTrend" />
        </AreaChart>
      </ResponsiveContainer>
      <div className="mt-2 flex gap-4 text-xs text-text-muted">
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: CHART_COLORS.warning }} /> Funding Pressure</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: CHART_COLORS.blue }} /> OI Trend</span>
      </div>
    </Section>
  );
}

// ─── Liquidation Imbalance ─────────────────────────────────────────────────

function LiquidationImbalancePanel() {
  const { data: f, isLoading: fLoading } = useDerivativesFeatures();
  const { data: history, isLoading: hLoading } = useDerivativesHistory();

  if (fLoading || hLoading) return <SectionSkeleton />;

  const imbalance = f?.liquidationImbalance ?? 0;
  const label = imbalance > 0.3 ? 'Long-Heavy' : imbalance < -0.3 ? 'Short-Heavy' : 'Balanced';
  const color = imbalance > 0.3 ? CHART_COLORS.negative : imbalance < -0.3 ? CHART_COLORS.positive : CHART_COLORS.blue;
  const pct = ((imbalance + 1) / 2) * 100;

  const chartData = (history ?? []).map((pt) => ({
    time: new Date(pt.eventTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    intensity: pt.features.liquidationIntensity * 100,
  }));

  return (
    <Section title="Liquidation Imbalance" icon={Flame}>
      {/* Gauge */}
      <div className="space-y-1.5 mb-4">
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-muted">Short-Heavy</span>
          <span className="font-semibold text-sm" style={{ color }}>{label}</span>
          <span className="text-text-muted">Long-Heavy</span>
        </div>
        <div className="relative h-4 w-full rounded-full bg-surface-2 overflow-hidden">
          <div className="absolute left-1/2 top-0 h-full w-px bg-text-muted/40" />
          <div
            className="absolute top-0.5 h-3 w-3 rounded-full transition-all duration-500 -translate-x-1/2"
            style={{ left: `${pct}%`, background: color, boxShadow: `0 0 8px ${color}60` }}
          />
        </div>
        <div className="text-center text-xs tabular-nums text-text-secondary">
          {imbalance >= 0 ? '+' : ''}{(imbalance * 100).toFixed(1)}%
        </div>
      </div>

      {/* Intensity chart */}
      <p className="mb-1 text-xs text-text-muted">Liquidation Intensity Over Time</p>
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
          <XAxis dataKey="time" {...AXIS_PROPS} interval="preserveStartEnd" />
          <YAxis {...AXIS_PROPS} domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} width={40} />
          <Tooltip
            contentStyle={{ background: '#111113', border: '1px solid #2e2e33', borderRadius: 6, fontSize: 12 }}
            labelStyle={{ color: CHART_COLORS.text }}
            formatter={(v: number) => [`${v.toFixed(0)}%`, 'Intensity']}
          />
          <Area type="monotone" dataKey="intensity" stroke={CHART_COLORS.warning} fill={CHART_COLORS.warning} fillOpacity={0.15} strokeWidth={1.5} />
        </AreaChart>
      </ResponsiveContainer>
    </Section>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function DerivativesPage() {
  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Derivatives Feed"
        subtitle="Binance Futures: funding rate, open interest & liquidations (BTCUSDT)"
      />

      <DerivativesKpis />

      <div className="grid grid-cols-2 gap-6">
        <SentimentPanel />
        <LiquidationImbalancePanel />
      </div>

      <div className="grid grid-cols-2 gap-6">
        <FundingRatePanel />
        <LiquidationFeed />
      </div>
    </div>
  );
}
