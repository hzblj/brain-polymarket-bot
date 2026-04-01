"use client";

import {
  Activity,
  BarChart3,
  Clock,
  Crosshair,
  Layers,
  Shield,
  TrendingUp,
  Zap,
} from "lucide-react";

import { KpiCard } from "@/components/cards/kpi-card";
import { HealthTile } from "@/components/cards/health-tile";
import { PipelineStep } from "@/components/cards/pipeline-step";
import { StreakCard } from "@/components/cards/streak-card";
import { StatusBadge } from "@/components/badges/status-badge";
import { PnlBadge } from "@/components/badges/pnl-badge";
import { SideBadge } from "@/components/badges/side-badge";
import { DataTable } from "@/components/tables/data-table";

import {
  useSystemState,
  useMarketSnapshot,
  usePipeline,
  useOpenTrades,
  useClosedTrades,
  useServiceHealth,
  useTodayMetrics,
  useSimulationSummary,
  useBlockchainActivity,
  useDerivativesFeatures,
  usePriceHistory,
} from "@/lib/hooks";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";

import {
  formatUsd,
  formatPct,
  formatPnl,
  formatDuration,
  formatTimeAgo,
  formatPrice,
} from "@/lib/formatters";

const CHART_COLORS = {
  accent: '#00e639',
  negative: '#ef4444',
  grid: '#2e2e33',
  text: '#71717a',
  startLine: '#f59e0b',
};

function BtcPriceChart({ startPrice }: { startPrice: number }) {
  const { data: history, isLoading } = usePriceHistory('5m');

  if (isLoading || !history || history.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-1 p-4">
        <div className="h-[180px] flex items-center justify-center text-text-muted text-sm">
          Loading BTC chart...
        </div>
      </div>
    );
  }

  const dataPoints = history.map((pt) => ({
    ...pt,
    label: new Date(pt.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  }));

  const lastPrice = dataPoints[dataPoints.length - 1]?.resolverPrice ?? 0;

  // Add 5 min of empty future points so chart has right-side breathing room
  const lastTime = history[history.length - 1]?.time ?? Date.now();
  const futurePoints = Array.from({ length: 20 }, (_, i) => ({
    label: new Date(lastTime + (i + 1) * 15_000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    resolverPrice: undefined as number | undefined,
  }));
  const chartData = [...dataPoints, ...futurePoints];
  const isUp = lastPrice > startPrice;

  return (
    <div className="rounded-lg border border-border bg-surface-1 px-2 pt-2 pb-8">
      <div className="flex items-center justify-between mb-1 px-2">
        <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
          BTC/USD
        </h2>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-text-muted">Start: ${formatPrice(startPrice, 2)}</span>
          <span className={isUp ? 'text-positive font-bold' : 'text-negative font-bold'}>
            Now: ${formatPrice(lastPrice, 2)} {isUp ? '▲' : '▼'}
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={chartData} margin={{ top: 4, right: 60, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: CHART_COLORS.text, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            padding={{ left: 10, right: 10 }}
          />
          <YAxis
            orientation="right"
            tick={{ fill: CHART_COLORS.text, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            domain={['dataMin - 30', 'dataMax + 30']}
            tickFormatter={(v: number) => `$${v.toLocaleString()}`}
            width={55}
            padding={{ top: 10, bottom: 10 }}
          />
          <Tooltip
            contentStyle={{ background: '#111113', border: '1px solid #2e2e33', borderRadius: 6, fontSize: 12 }}
            labelStyle={{ color: CHART_COLORS.text }}
            formatter={(v: number) => [`$${formatPrice(v, 2)}`, 'BTC']}
          />
          {startPrice > 0 && (
            <ReferenceLine
              y={startPrice}
              stroke={CHART_COLORS.startLine}
              strokeDasharray="4 4"
              strokeWidth={1}
              label={{ value: 'Start', fill: CHART_COLORS.startLine, fontSize: 10, position: 'left' }}
            />
          )}
          <Line
            type="monotone"
            dataKey="resolverPrice"
            stroke={isUp ? CHART_COLORS.accent : CHART_COLORS.negative}
            strokeWidth={2}
            dot={(props: Record<string, unknown>) => {
              const { cx, cy, index } = props as { cx: number; cy: number; index: number };
              if (index !== dataPoints.length - 1) return <circle key={index} r={0} />;
              return (
                <g key="live-dot">
                  <circle cx={cx} cy={cy} r={4} fill={isUp ? CHART_COLORS.accent : CHART_COLORS.negative} />
                  <circle cx={cx} cy={cy} r={8} fill={isUp ? CHART_COLORS.accent : CHART_COLORS.negative} opacity={0.3}>
                    <animate attributeName="r" from="4" to="12" dur="1.5s" repeatCount="indefinite" />
                    <animate attributeName="opacity" from="0.4" to="0" dur="1.5s" repeatCount="indefinite" />
                  </circle>
                </g>
              );
            }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function OverviewPage() {
  const system = useSystemState();
  const snapshot = useMarketSnapshot();
  const pipeline = usePipeline();
  const openTrades = useOpenTrades();
  const closedTrades = useClosedTrades();
  const health = useServiceHealth();
  const metrics = useTodayMetrics();
  const simulation = useSimulationSummary();

  const s = system.data;
  const m = snapshot.data;
  const pipe = pipeline.data;
  const open = openTrades.data;
  const closed = closedTrades.data;
  const services = health.data;
  const today = metrics.data;
  const sim = simulation.data;
  const bc = useBlockchainActivity().data;
  const deriv = useDerivativesFeatures().data;

  const totalUnrealized =
    open?.reduce((sum, t) => sum + t.unrealizedPnl, 0) ?? 0;

  const lastPipelineStep = pipe?.[pipe.length - 1];

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ── KPI Strip ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <KpiCard
          label="Current Mode"
          value={s?.mode ?? "—"}
          icon={Zap}
          subtitle={
            s ? (
              <StatusBadge
                status={s.mode as "paper" | "live" | "disabled"}
                size="sm"
              />
            ) : undefined
          }
        />
        <KpiCard
          label="Active Market"
          value={s?.activeMarket?.asset ?? "—"}
          icon={Crosshair}
        />
        <KpiCard
          label="Time To Close"
          value={m?.timeToCloseMs != null ? formatDuration(m.timeToCloseMs) : "—"}
          icon={Clock}
        />
        <KpiCard
          label="Risk State"
          value={s?.killSwitch ? "KILLED" : "Enabled"}
          icon={Shield}
          variant={s?.killSwitch ? "negative" : "positive"}
          subtitle={
            s ? (
              <StatusBadge
                status={s.killSwitch ? "unhealthy" : "healthy"}
                size="sm"
              />
            ) : undefined
          }
        />
        <KpiCard
          label="Open Positions"
          value={open?.length ?? 0}
          icon={BarChart3}
          subtitle={formatPnl(totalUnrealized)}
          variant={
            totalUnrealized > 0
              ? "positive"
              : totalUnrealized < 0
                ? "negative"
                : "default"
          }
        />
        <KpiCard
          label="Today PnL"
          value={today ? formatPnl(today.realizedPnl) : "—"}
          icon={TrendingUp}
          variant={
            today
              ? today.realizedPnl > 0
                ? "positive"
                : today.realizedPnl < 0
                  ? "negative"
                  : "default"
              : "default"
          }
        />
      </div>

      {/* ── Row 1: Pipeline + Chart + Market Snapshot ─────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Left: Pipeline + Chart stacked */}
        <div className="lg:col-span-3 flex flex-col gap-4">
          {/* Live Decision Pipeline */}
          <div className="rounded-lg border border-border bg-surface-1 p-4">
            <h2 className="mb-3 text-sm font-semibold text-text-secondary uppercase tracking-wider">
              Live Decision Pipeline
            </h2>
            {pipe ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                {pipe.map((step) => (
                  <PipelineStep
                    key={step.label}
                    label={step.label}
                    status={step.status as "pending" | "running" | "success" | "failed" | "skipped"}
                    value={step.value ?? undefined}
                    confidence={step.confidence ?? undefined}
                    timestamp={step.timestamp ?? undefined}
                    detail={step.detail ?? null}
                  />
                ))}
              </div>
            ) : (
              <p className="text-text-muted text-sm">Loading...</p>
            )}
          </div>

          {/* BTC Price Chart */}
          <BtcPriceChart startPrice={m?.startPrice ?? 0} />
        </div>

        {/* Right: Live Market Snapshot */}
        <div className="lg:col-span-2 rounded-lg border border-accent/20 bg-surface-2/60 backdrop-blur-sm p-4 glow-accent">
          <h2 className="mb-4 text-sm font-semibold text-accent uppercase tracking-wider">
            Live Market Snapshot
          </h2>
          {m ? (
            <div className="flex flex-col gap-3">
              {/* Hero prices */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-md bg-surface-0/50 px-3 py-2">
                  <span className="block text-[10px] uppercase tracking-wider text-text-muted">Resolver</span>
                  <span className="text-xl font-bold tabular-nums text-accent">${formatPrice(m.resolverPrice, 2)}</span>
                </div>
                <div className="rounded-md bg-surface-0/50 px-3 py-2">
                  <span className="block text-[10px] uppercase tracking-wider text-text-muted">Spot</span>
                  <span className="text-xl font-bold tabular-nums text-text-primary">${formatPrice(m.spotPrice, 2)}</span>
                </div>
              </div>

              {/* Delta + Time to close */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-md bg-surface-0/50 px-3 py-2">
                  <span className="block text-[10px] uppercase tracking-wider text-text-muted">Delta</span>
                  <span className={`text-lg font-semibold tabular-nums ${m.deltaAbs >= 0 ? 'text-positive' : 'text-negative'}`}>
                    {m.deltaAbs >= 0 ? '+' : ''}{formatPrice(m.deltaAbs, 4)} ({formatPct(m.deltaPct)})
                  </span>
                </div>
                <div className="rounded-md bg-surface-0/50 px-3 py-2">
                  <span className="block text-[10px] uppercase tracking-wider text-text-muted">Closes In</span>
                  <span className={`text-lg font-semibold tabular-nums ${m.timeToCloseMs < 30000 ? 'text-negative' : m.timeToCloseMs < 60000 ? 'text-warning' : 'text-text-primary'}`}>
                    {formatDuration(m.timeToCloseMs)}
                  </span>
                </div>
              </div>

              {/* Metrics grid */}
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="rounded bg-surface-0/40 px-2 py-1.5">
                  <span className="block text-text-muted">Spread</span>
                  <span className="font-medium tabular-nums text-text-primary">{formatPrice(m.spread, 1)} bps</span>
                </div>
                <div className="rounded bg-surface-0/40 px-2 py-1.5">
                  <span className="block text-text-muted">Depth</span>
                  <span className="font-medium tabular-nums text-text-primary">{formatPrice(m.depthScore, 2)}</span>
                </div>
                <div className="rounded bg-surface-0/40 px-2 py-1.5">
                  <span className="block text-text-muted">Imbalance</span>
                  <span className="font-medium tabular-nums text-text-primary">{formatPct(m.imbalance)}</span>
                </div>
              </div>

              {/* Bid/Ask levels */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded bg-positive/5 border border-positive/10 px-2 py-1.5">
                  <span className="block text-text-muted">UP Bid / Ask</span>
                  <span className="font-medium tabular-nums text-positive">{formatPrice(m.upBid, 4)}</span>
                  <span className="text-text-muted"> / </span>
                  <span className="font-medium tabular-nums text-text-secondary">{formatPrice(m.upAsk, 4)}</span>
                </div>
                <div className="rounded bg-negative/5 border border-negative/10 px-2 py-1.5">
                  <span className="block text-text-muted">DOWN Bid / Ask</span>
                  <span className="font-medium tabular-nums text-negative">{formatPrice(m.downBid, 4)}</span>
                  <span className="text-text-muted"> / </span>
                  <span className="font-medium tabular-nums text-text-secondary">{formatPrice(m.downAsk, 4)}</span>
                </div>
              </div>

              {/* Liquidity */}
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="rounded bg-surface-0/40 px-2 py-1.5">
                  <span className="block text-text-muted">Liquidity</span>
                  <span className="font-medium tabular-nums text-accent">${formatPrice((m as Record<string, unknown>).liquidityUsd as number ?? 0, 0)}</span>
                </div>
                <div className="rounded bg-surface-0/40 px-2 py-1.5">
                  <span className="block text-text-muted">24h Vol</span>
                  <span className="font-medium tabular-nums text-text-primary">${formatPrice((m as Record<string, unknown>).volume24hUsd as number ?? 0, 0)}</span>
                </div>
                <div className="rounded bg-surface-0/40 px-2 py-1.5">
                  <span className="block text-text-muted">Depth</span>
                  <span className="font-medium tabular-nums text-text-primary">${formatPrice((m as Record<string, unknown>).totalDepthUsd as number ?? 0, 0)}</span>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-text-muted text-sm">Loading...</p>
          )}
        </div>
      </div>

      {/* ── Row 2: Open Trades + Health Summary ────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Open Trades */}
        <div className="lg:col-span-3 rounded-lg border border-border bg-surface-1 p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-secondary uppercase tracking-wider">
            Open Trades
          </h2>
          <DataTable
            columns={[
              {
                key: "side",
                label: "Side",
                render: (row) => <SideBadge side={row.side} />,
              },
              { key: "strategy", label: "Strategy" },
              {
                key: "entryPrice",
                label: "Entry",
                render: (row) => formatPrice(row.entryPrice, 4),
              },
              {
                key: "sizeUsd",
                label: "Size",
                render: (row) => formatUsd(row.sizeUsd),
              },
              {
                key: "currentMark",
                label: "Mark",
                render: (row) => formatPrice(row.currentMark, 4),
              },
              {
                key: "unrealizedPnl",
                label: "Unrealized PnL",
                render: (row) => <PnlBadge value={row.unrealizedPnl} showSign />,
              },
              {
                key: "status",
                label: "Status",
                render: (row) => (
                  <span className="text-xs text-text-secondary capitalize">{row.status}</span>
                ),
              },
            ]}
            data={open ?? []}
            emptyMessage="No open positions"
          />
        </div>

        {/* Health Summary */}
        <div className="lg:col-span-2 rounded-lg border border-border bg-surface-1 p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-secondary uppercase tracking-wider">
            Health Summary
          </h2>
          {services ? (
            <div className="grid grid-cols-2 gap-2">
              {services.map((svc) => (
                <HealthTile
                  key={svc.name}
                  name={svc.name}
                  status={svc.status}
                  lastHeartbeat={svc.lastHeartbeat}
                  latencyMs={svc.latencyMs}
                />
              ))}
            </div>
          ) : (
            <p className="text-text-muted text-sm">Loading...</p>
          )}
        </div>
      </div>

      {/* ── Row 3: Closed Trades + Simulation Summary ──────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Closed Trades Today */}
        <div className="lg:col-span-3 rounded-lg border border-border bg-surface-1 p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-secondary uppercase tracking-wider">
            Closed Trades Today
          </h2>
          <DataTable
            columns={[
              {
                key: "side",
                label: "Side",
                render: (row) => <SideBadge side={row.side} />,
              },
              {
                key: "result",
                label: "Result",
                render: (row) => (
                  <span
                    className={
                      row.result === "win"
                        ? "text-positive font-medium"
                        : row.result === "loss"
                          ? "text-negative font-medium"
                          : "text-text-muted font-medium"
                    }
                  >
                    {row.result.toUpperCase()}
                  </span>
                ),
              },
              {
                key: "pnl",
                label: "PnL",
                render: (row) => <PnlBadge value={row.pnl} showSign />,
              },
              {
                key: "duration",
                label: "Duration",
                render: (row) => formatDuration(row.duration),
              },
              { key: "exitReason", label: "Exit Reason" },
            ]}
            data={closed ?? []}
            emptyMessage="No closed trades today"
          />
        </div>

        {/* Simulation Summary */}
        <div className="lg:col-span-2 rounded-lg border border-border bg-surface-1 p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-secondary uppercase tracking-wider">
            Simulation Summary
          </h2>
          {sim ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <SnapshotRow label="Paper Trades" value={String(sim.paperTradesToday)} />
                <SnapshotRow label="Win Rate" value={formatPct(sim.winRate)} />
                <SnapshotRow label="Profit Factor" value={formatPrice(sim.profitFactor, 2)} />
                <SnapshotRow label="Avg PnL" value={formatPnl(sim.avgPnl)} />
                <SnapshotRow label="Avg Hold Time" value={sim.avgHoldTime} />
                <SnapshotRow label="False Positive" value={formatPct(sim.falsePositiveRate)} />
                <SnapshotRow label="No-Trade Rate" value={formatPct(sim.noTradeRate)} />
              </div>
              <div className="flex gap-2">
                <StreakCard
                  label="Win Streak"
                  value={sim.currentWinStreak}
                  type="win"
                />
                <StreakCard
                  label="Loss Streak"
                  value={sim.currentLossStreak}
                  type="loss"
                />
                <StreakCard
                  label="Green Days"
                  value={sim.greenDayStreak}
                  type="neutral"
                />
              </div>
            </div>
          ) : (
            <p className="text-text-muted text-sm">Loading...</p>
          )}
        </div>
      </div>

      {/* ── Derivatives Strip ─────────────────────────────────────── */}
      {deriv && (
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-secondary uppercase tracking-wider">
            Derivatives (Binance Futures)
          </h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <SnapshotRow label="Funding Rate" value={`${(deriv.fundingRate * 100).toFixed(4)}%`} />
            <SnapshotRow label="Funding (Annual)" value={`${(deriv.fundingRateAnnualized * 100).toFixed(1)}%`} />
            <SnapshotRow label="Open Interest" value={`$${formatPrice(deriv.openInterestUsd / 1e9, 2)}B`} />
            <SnapshotRow label="OI Change" value={`${deriv.openInterestChangePct >= 0 ? '+' : ''}${formatPrice(deriv.openInterestChangePct, 2)}%`} />
            <SnapshotRow label="Long Liqs" value={`$${formatPrice(deriv.longLiquidationUsd / 1000, 0)}K`} />
            <SnapshotRow label="Short Liqs" value={`$${formatPrice(deriv.shortLiquidationUsd / 1000, 0)}K`} />
            <SnapshotRow label="Liq Intensity" value={`${(deriv.liquidationIntensity * 100).toFixed(0)}%`} />
            <SnapshotRow label="Sentiment" value={
              deriv.derivativesSentiment > 0.3 ? `Bullish (${(deriv.derivativesSentiment * 100).toFixed(0)}%)`
              : deriv.derivativesSentiment < -0.3 ? `Bearish (${(deriv.derivativesSentiment * 100).toFixed(0)}%)`
              : `Neutral (${(deriv.derivativesSentiment * 100).toFixed(0)}%)`
            } />
          </div>
        </div>
      )}

      {/* ── Blockchain Activity Strip ──────────────────────────────── */}
      {bc && (
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-secondary uppercase tracking-wider">
            Blockchain Activity
          </h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <SnapshotRow label="Mempool Txs" value={bc.mempool.txCount.toLocaleString()} />
            <SnapshotRow label="Fastest Fee" value={`${bc.fees.fastest} sat/vB`} />
            <SnapshotRow label="Latest Block" value={bc.latestBlock ? `#${bc.latestBlock.height.toLocaleString()}` : '—'} />
            <SnapshotRow label="Notable Txs" value={`${bc.notableTransactions.total} (${formatPrice(bc.notableTransactions.totalBtc, 0)} BTC)`} />
            <SnapshotRow label="Exchange In" value={bc.notableTransactions.exchangeInflows.count > 0 ? `${bc.notableTransactions.exchangeInflows.count} (${formatPrice(bc.notableTransactions.exchangeInflows.btc, 1)} BTC)` : '—'} />
            <SnapshotRow label="Exchange Out" value={bc.notableTransactions.exchangeOutflows.count > 0 ? `${bc.notableTransactions.exchangeOutflows.count} (${formatPrice(bc.notableTransactions.exchangeOutflows.btc, 1)} BTC)` : '—'} />
            <SnapshotRow label="Tx Trend" value={`${bc.trend.txCountChange > 0 ? '↑' : bc.trend.txCountChange < 0 ? '↓' : '→'} ${(bc.trend.txCountChange * 100).toFixed(0)}%`} />
            <SnapshotRow label="Fee Trend" value={`${bc.trend.feeChange > 0 ? '↑' : bc.trend.feeChange < 0 ? '↓' : '→'} ${(bc.trend.feeChange * 100).toFixed(0)}%`} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Tiny helper for key-value rows ───────────────────────────────────── */
function SnapshotRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-text-muted">{label}</span>
      <span className="text-text-primary font-mono text-right">{value}</span>
    </>
  );
}
