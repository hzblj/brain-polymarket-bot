"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { KpiCard } from "@/components/cards/kpi-card";
import { DataTable } from "@/components/tables/data-table";
import { PnlBadge } from "@/components/badges/pnl-badge";
import { SideBadge } from "@/components/badges/side-badge";
import { StatusBadge } from "@/components/badges/status-badge";
import { useOpenTrades } from "@/lib/hooks";
import { useClosedTrades } from "@/lib/hooks";
import { useTodayMetrics } from "@/lib/hooks";
import {
  formatUsd,
  formatPct,
  formatPnl,
  formatDuration,
  formatTimeAgo,
  formatPrice,
} from "@/lib/formatters";

type Tab = "open" | "closed";

const resultColorMap: Record<string, string> = {
  win: "text-positive",
  loss: "text-negative",
  breakeven: "text-text-muted",
};

export default function TradesPage() {
  const [activeTab, setActiveTab] = useState<Tab>("open");

  const { data: openTrades } = useOpenTrades();
  const { data: closedTrades } = useClosedTrades();
  const { data: metrics } = useTodayMetrics();

  const isLoading = !openTrades || !closedTrades || !metrics;

  const openColumns: {
    key: string;
    label: string;
    render?: (row: any) => ReactNode;
  }[] = [
    {
      key: "id",
      label: "ID",
      render: (row) => (
        <span className="font-mono text-text-secondary" title={row.id}>
          {row.id.slice(0, 8)}
        </span>
      ),
    },
    {
      key: "side",
      label: "Side",
      render: (row) => <SideBadge side={row.side} />,
    },
    { key: "strategy", label: "Strategy" },
    {
      key: "mode",
      label: "Mode",
      render: (row) => <StatusBadge status={row.mode} />,
    },
    {
      key: "entryTime",
      label: "Entry Time",
      render: (row) => (
        <span className="text-text-secondary">
          {formatTimeAgo(row.entryTime)}
        </span>
      ),
    },
    {
      key: "entryPrice",
      label: "Entry Price",
      render: (row) => formatPrice(row.entryPrice, 2),
    },
    {
      key: "sizeUsd",
      label: "Size USD",
      render: (row) => formatUsd(row.sizeUsd),
    },
    {
      key: "currentMark",
      label: "Current Mark",
      render: (row) => formatPrice(row.currentMark),
    },
    {
      key: "unrealizedPnl",
      label: "Unrealized PnL",
      render: (row) => <PnlBadge value={row.unrealizedPnl} />,
    },
    { key: "status", label: "Status" },
  ];

  const closedColumns: {
    key: string;
    label: string;
    render?: (row: any) => ReactNode;
  }[] = [
    {
      key: "id",
      label: "ID",
      render: (row) => (
        <span className="font-mono text-text-secondary" title={row.id}>
          {row.id.slice(0, 8)}
        </span>
      ),
    },
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
          className={`font-medium capitalize ${resultColorMap[row.result] ?? "text-text-muted"}`}
        >
          {row.result}
        </span>
      ),
    },
    {
      key: "pnl",
      label: "PnL",
      render: (row) => <PnlBadge value={row.pnl} />,
    },
    {
      key: "pnlPct",
      label: "PnL %",
      render: (row) => (
        <span className={row.pnlPct >= 0 ? "text-positive" : "text-negative"}>
          {formatPct(row.pnlPct)}
        </span>
      ),
    },
    {
      key: "duration",
      label: "Duration",
      render: (row) => (
        <span className="text-text-secondary">
          {formatDuration(row.duration)}
        </span>
      ),
    },
    { key: "exitReason", label: "Exit Reason" },
    {
      key: "entryTime",
      label: "Entry Time",
      render: (row) => (
        <span className="text-text-secondary">
          {formatTimeAgo(row.entryTime)}
        </span>
      ),
    },
  ];

  const tabClass = (tab: Tab) =>
    tab === activeTab
      ? "border-b-2 border-accent text-text-primary px-4 py-2 font-medium"
      : "text-text-muted hover:text-text-secondary px-4 py-2 font-medium border-b-2 border-transparent";

  return (
    <div className="space-y-6">
      <PageHeader title="Trades" />

      {activeTab === "closed" && metrics && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <KpiCard
            label="Total PnL"
            value={formatPnl(metrics.realizedPnl)}
          />
          <KpiCard
            label="Win Rate"
            value={formatPct(metrics.winRate)}
          />
          <KpiCard
            label="Profit Factor"
            value={metrics.profitFactor.toFixed(2)}
          />
          <KpiCard
            label="Trade Count"
            value={metrics.tradeCount}
          />
        </div>
      )}

      <div className="flex gap-2 border-b border-border">
        <button type="button" className={tabClass("open")} onClick={() => setActiveTab("open")}>
          Open Trades
        </button>
        <button type="button" className={tabClass("closed")} onClick={() => setActiveTab("closed")}>
          Closed Trades
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-text-muted">
          Loading trades...
        </div>
      ) : activeTab === "open" ? (
        <DataTable
          columns={openColumns}
          data={openTrades}
          emptyMessage="No open trades"
        />
      ) : (
        <DataTable
          columns={closedColumns}
          data={closedTrades}
          emptyMessage="No closed trades"
        />
      )}
    </div>
  );
}
