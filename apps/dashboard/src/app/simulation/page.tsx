"use client";

import {
  Activity,
  BarChart3,
  Clock,
  Target,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { KpiCard } from "@/components/cards/kpi-card";
import { StreakCard } from "@/components/cards/streak-card";
import { DataTable } from "@/components/tables/data-table";
import { PnlBadge } from "@/components/badges/pnl-badge";
import { SideBadge } from "@/components/badges/side-badge";
import {
  useSimulationSummary,
  useClosedTrades,
  useOpenTrades,
} from "@/lib/hooks";
import {
  formatUsd,
  formatPct,
  formatPnl,
  formatDuration,
  formatTimeAgo,
} from "@/lib/formatters";

export default function SimulationPage() {
  const { data: sim } = useSimulationSummary();
  const { data: closed } = useClosedTrades();
  const { data: open } = useOpenTrades();

  const recentTrades = (closed ?? []).slice(0, 30);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Simulation"
        subtitle="Paper trading performance and signal accuracy"
      />

      {/* Main KPIs */}
      {sim ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            <KpiCard
              label="P&L"
              value={formatPnl(sim.realizedPnl)}
              icon={TrendingUp}
              variant={sim.realizedPnl >= 0 ? "positive" : "negative"}
            />
            <KpiCard label="Trades" value={sim.tradeCount} icon={Activity} />
            <KpiCard
              label="Win Rate"
              value={formatPct(sim.winRate)}
              icon={Target}
              variant={sim.winRate >= 0.5 ? "positive" : "negative"}
            />
            <KpiCard
              label="Profit Factor"
              value={sim.profitFactor.toFixed(2)}
              icon={BarChart3}
              variant={sim.profitFactor >= 1 ? "positive" : "negative"}
            />
            <KpiCard
              label="Avg P&L"
              value={formatPnl(sim.avgPnl)}
              icon={Zap}
              variant={sim.avgPnl >= 0 ? "positive" : "negative"}
            />
            <KpiCard label="Avg Hold" value={sim.avgHoldTime} icon={Clock} />
            <KpiCard
              label="Paper Today"
              value={sim.paperTradesToday}
              icon={Activity}
            />
            <KpiCard
              label="No-Trade %"
              value={formatPct(sim.noTradeRate)}
              icon={TrendingDown}
              variant="warning"
            />
          </div>

          {/* Streaks & Signal Quality */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-border bg-surface-1 p-4">
              <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
                Streaks
              </h3>
              <div className="grid grid-cols-3 gap-3">
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
                  type={sim.greenDayStreak > 0 ? "win" : "neutral"}
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-surface-1 p-4">
              <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
                Signal Quality
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <SignalMetric
                  label="Win Rate"
                  value={formatPct(sim.winRate)}
                  color={
                    sim.winRate >= 0.5 ? "text-positive" : "text-negative"
                  }
                />
                <SignalMetric
                  label="False Positive Rate"
                  value={formatPct(sim.falsePositiveRate)}
                  color={
                    sim.falsePositiveRate <= 0.3
                      ? "text-positive"
                      : "text-negative"
                  }
                />
                <SignalMetric
                  label="No-Trade Rate"
                  value={formatPct(sim.noTradeRate)}
                  color={
                    sim.noTradeRate <= 0.5 ? "text-positive" : "text-warning"
                  }
                />
                <SignalMetric
                  label="Profit Factor"
                  value={sim.profitFactor.toFixed(2)}
                  color={
                    sim.profitFactor >= 1 ? "text-positive" : "text-negative"
                  }
                />
              </div>
            </div>
          </div>

          {/* Win / Loss bar */}
          <div className="rounded-lg border border-border bg-surface-1 p-4">
            <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
              Win / Loss Breakdown
            </h3>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <div className="flex h-4 rounded-full overflow-hidden bg-surface-2">
                  {sim.tradeCount > 0 && (
                    <>
                      <div
                        className="bg-positive transition-all"
                        style={{
                          width: `${(sim.winCount / sim.tradeCount) * 100}%`,
                        }}
                      />
                      <div
                        className="bg-negative transition-all"
                        style={{
                          width: `${(sim.lossCount / sim.tradeCount) * 100}%`,
                        }}
                      />
                    </>
                  )}
                </div>
              </div>
              <div className="flex gap-4 text-xs">
                <span className="text-positive">{sim.winCount}W</span>
                <span className="text-negative">{sim.lossCount}L</span>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-center rounded-lg border border-border bg-surface-1 p-12">
          <p className="text-text-muted text-sm">Loading simulation data...</p>
        </div>
      )}

      {/* Open Positions */}
      {open && open.length > 0 && (
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
            Open Positions ({open.length})
          </h3>
          <DataTable
            columns={[
              {
                key: "side",
                label: "Side",
                render: (r) => (
                  <SideBadge side={r.side as "buy_up" | "buy_down"} />
                ),
              },
              { key: "strategy", label: "Strategy" },
              {
                key: "entryPrice",
                label: "Entry",
                render: (r) => `$${r.entryPrice.toFixed(4)}`,
              },
              {
                key: "sizeUsd",
                label: "Size",
                render: (r) => formatUsd(r.sizeUsd),
              },
              {
                key: "currentMark",
                label: "Mark",
                render: (r) => `$${r.currentMark.toFixed(4)}`,
              },
              {
                key: "unrealizedPnl",
                label: "Unrealized",
                render: (r) => <PnlBadge value={r.unrealizedPnl} />,
              },
              {
                key: "entryTime",
                label: "Opened",
                render: (r) => formatTimeAgo(r.entryTime),
              },
            ]}
            data={open}
          />
        </div>
      )}

      {/* Recent Closed Trades */}
      <div className="rounded-lg border border-border bg-surface-1 p-4">
        <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
          Recent Trades
        </h3>
        {recentTrades.length > 0 ? (
          <DataTable
            columns={[
              {
                key: "side",
                label: "Side",
                render: (r) => (
                  <SideBadge side={r.side as "buy_up" | "buy_down"} />
                ),
              },
              { key: "strategy", label: "Strategy" },
              {
                key: "pnl",
                label: "P&L",
                render: (r) => <PnlBadge value={r.pnl} />,
              },
              {
                key: "pnlPct",
                label: "P&L %",
                render: (r) => (
                  <span
                    className={
                      r.pnlPct >= 0 ? "text-positive" : "text-negative"
                    }
                  >
                    {(r.pnlPct * 100).toFixed(1)}%
                  </span>
                ),
              },
              {
                key: "result",
                label: "Result",
                render: (r) => <ResultBadge result={r.result} />,
              },
              { key: "exitReason", label: "Exit Reason" },
              {
                key: "duration",
                label: "Duration",
                render: (r) => formatDuration(r.duration),
              },
              {
                key: "exitTime",
                label: "Closed",
                render: (r) => formatTimeAgo(r.exitTime),
              },
            ]}
            data={recentTrades}
          />
        ) : (
          <p className="text-text-muted text-sm text-center py-6">
            No closed trades yet
          </p>
        )}
      </div>
    </div>
  );
}

function SignalMetric({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
      <p className="text-xs text-text-muted">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function ResultBadge({ result }: { result: string }) {
  const colorMap: Record<string, string> = {
    win: "bg-positive/10 text-positive",
    loss: "bg-negative/10 text-negative",
    breakeven: "bg-warning/10 text-warning",
  };
  const cls = colorMap[result] ?? "bg-surface-2 text-text-muted";
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 text-xs font-semibold ${cls}`}
    >
      {result}
    </span>
  );
}
