"use client";

import {
  Activity,
  BarChart3,
  DollarSign,
  Shield,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { KpiCard } from "@/components/cards/kpi-card";
import { DataTable } from "@/components/tables/data-table";
import { PnlBadge } from "@/components/badges/pnl-badge";
import {
  useTodayMetrics,
  useClosedTrades,
  useTradeAnalyses,
} from "@/lib/hooks";
import { formatPct, formatPnl, formatDuration } from "@/lib/formatters";

export default function PerformancePage() {
  const { data: metrics } = useTodayMetrics();
  const { data: closed } = useClosedTrades();
  const { data: analyses } = useTradeAnalyses();

  const trades = closed ?? [];

  // Hourly P&L
  const hourlyPnl: Record<number, { pnl: number; count: number }> = {};
  for (const t of trades) {
    const hour = new Date(t.exitTime).getUTCHours();
    if (!hourlyPnl[hour]) hourlyPnl[hour] = { pnl: 0, count: 0 };
    hourlyPnl[hour].pnl += t.pnl;
    hourlyPnl[hour].count += 1;
  }

  // Per-side stats
  const upTrades = trades.filter((t) => t.side === "buy_up");
  const downTrades = trades.filter((t) => t.side === "buy_down");
  const upPnl = upTrades.reduce((s, t) => s + t.pnl, 0);
  const downPnl = downTrades.reduce((s, t) => s + t.pnl, 0);
  const upWinRate =
    upTrades.length > 0
      ? upTrades.filter((t) => t.result === "win").length / upTrades.length
      : 0;
  const downWinRate =
    downTrades.length > 0
      ? downTrades.filter((t) => t.result === "win").length / downTrades.length
      : 0;

  // Exit reasons
  const exitReasons: Record<string, { count: number; pnl: number }> = {};
  for (const t of trades) {
    const reason = t.exitReason || "unknown";
    if (!exitReasons[reason]) exitReasons[reason] = { count: 0, pnl: 0 };
    exitReasons[reason].count += 1;
    exitReasons[reason].pnl += t.pnl;
  }
  const exitReasonRows = Object.entries(exitReasons)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([reason, data]) => ({ reason, ...data }));

  // Agent accuracy
  const totalAnalyses = analyses?.length ?? 0;
  const accurateEdge = analyses?.filter((a) => a.edgeAccurate).length ?? 0;
  const edgeAccuracy = totalAnalyses > 0 ? accurateEdge / totalAnalyses : 0;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Performance"
        subtitle="Detailed P&L analytics and trading statistics"
      />

      {metrics ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          <KpiCard
            label="Realized P&L"
            value={formatPnl(metrics.realizedPnl)}
            icon={DollarSign}
            variant={metrics.realizedPnl >= 0 ? "positive" : "negative"}
          />
          <KpiCard
            label="Unrealized"
            value={formatPnl(metrics.unrealizedPnl)}
            icon={TrendingUp}
            variant={metrics.unrealizedPnl >= 0 ? "positive" : "negative"}
          />
          <KpiCard label="Trades" value={metrics.tradeCount} icon={Activity} />
          <KpiCard
            label="Win Rate"
            value={formatPct(metrics.winRate)}
            icon={Target}
            variant={metrics.winRate >= 0.5 ? "positive" : "negative"}
          />
          <KpiCard
            label="Profit Factor"
            value={metrics.profitFactor.toFixed(2)}
            icon={BarChart3}
            variant={metrics.profitFactor >= 1 ? "positive" : "negative"}
          />
          <KpiCard
            label="Avg P&L"
            value={formatPnl(metrics.avgPnl)}
            icon={TrendingUp}
          />
          <KpiCard
            label="Max Drawdown"
            value={formatPnl(metrics.maxDrawdown)}
            icon={TrendingDown}
            variant="negative"
          />
          <KpiCard
            label="Edge Accuracy"
            value={formatPct(edgeAccuracy)}
            icon={Shield}
            variant={edgeAccuracy >= 0.5 ? "positive" : "warning"}
          />
        </div>
      ) : (
        <div className="flex items-center justify-center rounded-lg border border-border bg-surface-1 p-12">
          <p className="text-text-muted text-sm">Loading metrics...</p>
        </div>
      )}

      {/* UP vs DOWN */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SideCard
          side="UP"
          trades={upTrades.length}
          pnl={upPnl}
          winRate={upWinRate}
          color="positive"
        />
        <SideCard
          side="DOWN"
          trades={downTrades.length}
          pnl={downPnl}
          winRate={downWinRate}
          color="negative"
        />
      </div>

      {/* Hourly P&L */}
      <div className="rounded-lg border border-border bg-surface-1 p-4">
        <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
          P&L by Hour (UTC)
        </h3>
        <div className="grid grid-cols-12 gap-1">
          {Array.from({ length: 24 }, (_, h) => {
            const data = hourlyPnl[h];
            const pnl = data?.pnl ?? 0;
            const count = data?.count ?? 0;
            const maxPnl = Math.max(
              1,
              ...Object.values(hourlyPnl).map((d) => Math.abs(d.pnl))
            );
            const height =
              count > 0 ? Math.max(8, (Math.abs(pnl) / maxPnl) * 48) : 4;

            return (
              <div key={h} className="flex flex-col items-center gap-1">
                <div className="flex items-end h-12">
                  <div
                    className={`w-full rounded-sm transition-all ${
                      pnl >= 0 ? "bg-positive" : "bg-negative"
                    }`}
                    style={{ height: `${height}px`, minWidth: "6px" }}
                    title={`${h}:00 — ${count} trades, ${formatPnl(pnl)}`}
                  />
                </div>
                <span className="text-[9px] text-text-muted tabular-nums">
                  {h}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Exit Reasons */}
      {exitReasonRows.length > 0 && (
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
            Exit Reason Breakdown
          </h3>
          <DataTable
            columns={[
              { key: "reason", label: "Exit Reason" },
              { key: "count", label: "Trades" },
              {
                key: "pnl",
                label: "P&L",
                render: (r) => <PnlBadge value={r.pnl} />,
              },
              {
                key: "avgPnl",
                label: "Avg P&L",
                render: (r) => (
                  <PnlBadge value={r.count > 0 ? r.pnl / r.count : 0} />
                ),
              },
            ]}
            data={exitReasonRows}
          />
        </div>
      )}

      {/* Top Trades */}
      {trades.length > 0 && (
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
            Top Trades by Absolute P&L
          </h3>
          <DataTable
            columns={[
              {
                key: "side",
                label: "Side",
                render: (r) => (
                  <span
                    className={
                      r.side === "buy_up"
                        ? "text-positive font-semibold"
                        : "text-negative font-semibold"
                    }
                  >
                    {r.side === "buy_up" ? "UP" : "DOWN"}
                  </span>
                ),
              },
              { key: "strategy", label: "Strategy" },
              {
                key: "pnl",
                label: "P&L",
                render: (r) => <PnlBadge value={r.pnl} />,
              },
              {
                key: "result",
                label: "Result",
                render: (r) => (
                  <span
                    className={
                      r.result === "win"
                        ? "text-positive"
                        : r.result === "loss"
                          ? "text-negative"
                          : "text-warning"
                    }
                  >
                    {r.result}
                  </span>
                ),
              },
              {
                key: "duration",
                label: "Duration",
                render: (r) => formatDuration(r.duration),
              },
              { key: "exitReason", label: "Exit Reason" },
            ]}
            data={[...trades]
              .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
              .slice(0, 20)}
          />
        </div>
      )}
    </div>
  );
}

function SideCard({
  side,
  trades,
  pnl,
  winRate,
  color,
}: {
  side: string;
  trades: number;
  pnl: number;
  winRate: number;
  color: "positive" | "negative";
}) {
  return (
    <div
      className={`rounded-lg border bg-surface-1 p-4 ${color === "positive" ? "border-positive/30" : "border-negative/30"}`}
    >
      <h3
        className={`text-sm font-semibold uppercase tracking-wider mb-3 ${color === "positive" ? "text-positive" : "text-negative"}`}
      >
        {side} Performance
      </h3>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="text-xs text-text-muted">Trades</p>
          <p className="text-lg font-semibold text-text-primary tabular-nums">
            {trades}
          </p>
        </div>
        <div>
          <p className="text-xs text-text-muted">P&L</p>
          <p
            className={`text-lg font-semibold tabular-nums ${pnl >= 0 ? "text-positive" : "text-negative"}`}
          >
            {formatPnl(pnl)}
          </p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Win Rate</p>
          <p
            className={`text-lg font-semibold tabular-nums ${winRate >= 0.5 ? "text-positive" : "text-negative"}`}
          >
            {formatPct(winRate)}
          </p>
        </div>
      </div>
    </div>
  );
}
