"use client";

import { useState } from "react";
import {
  Activity,
  Clock,
  Play,
  RotateCcw,
  Target,
  TrendingUp,
} from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { KpiCard } from "@/components/cards/kpi-card";
import { DataTable } from "@/components/tables/data-table";
import { PnlBadge } from "@/components/badges/pnl-badge";
import { useReplaySummary } from "@/lib/hooks";
import { startReplay } from "@/lib/api";
import { formatPnl, formatPct } from "@/lib/formatters";

export default function ReplayPage() {
  const { data: summary, refetch } = useReplaySummary();
  const [isRunning, setIsRunning] = useState(false);
  const [hoursBack, setHoursBack] = useState(1);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const handleStartReplay = async () => {
    setIsRunning(true);
    setLastResult(null);
    try {
      const to = new Date().toISOString();
      const from = new Date(
        Date.now() - hoursBack * 60 * 60 * 1000
      ).toISOString();
      const result = await startReplay({ from, to });
      setLastResult(result?.replayId ?? "Started");
      refetch();
    } catch (err) {
      setLastResult(
        `Error: ${err instanceof Error ? err.message : "Unknown"}`
      );
    } finally {
      setIsRunning(false);
    }
  };

  const regimeRows = summary?.byRegime
    ? Object.entries(summary.byRegime)
        .map(([regime, data]) => ({
          regime,
          count: data.count,
          correct: data.correct,
          accuracy: data.count > 0 ? data.correct / data.count : 0,
          pnlUsd: data.pnlUsd,
        }))
        .sort((a, b) => b.count - a.count)
    : [];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Replay"
        subtitle="Re-run agent decisions on historical market windows"
      />

      {/* Run Replay */}
      <div className="rounded-lg border border-accent/20 bg-surface-2/60 backdrop-blur-sm p-4 glow-accent-sm">
        <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
          Run Replay
        </h3>
        <div className="flex items-end gap-4">
          <div>
            <label className="block text-xs text-text-muted mb-1">
              Hours back
            </label>
            <select
              value={hoursBack}
              onChange={(e) => setHoursBack(Number(e.target.value))}
              className="rounded border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            >
              <option value={1}>1 hour</option>
              <option value={2}>2 hours</option>
              <option value={4}>4 hours</option>
              <option value={8}>8 hours</option>
              <option value={24}>24 hours</option>
            </select>
          </div>
          <button
            onClick={handleStartReplay}
            disabled={isRunning}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunning ? (
              <RotateCcw className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {isRunning ? "Running..." : "Start Replay"}
          </button>
          {lastResult && (
            <span className="text-xs text-text-muted">
              {lastResult.startsWith("Error") ? (
                <span className="text-negative">{lastResult}</span>
              ) : (
                <span className="text-positive">
                  Replay ID: {lastResult}
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      {/* Summary KPIs */}
      {summary ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <KpiCard
              label="Total Replays"
              value={summary.totalReplays}
              icon={RotateCcw}
            />
            <KpiCard
              label="Windows"
              value={summary.totalWindows}
              icon={Activity}
            />
            <KpiCard
              label="Correct"
              value={summary.correctPredictions}
              icon={Target}
              variant="positive"
            />
            <KpiCard
              label="Accuracy"
              value={formatPct(summary.accuracy)}
              icon={Target}
              variant={summary.accuracy >= 0.5 ? "positive" : "negative"}
            />
            <KpiCard
              label="Total P&L"
              value={formatPnl(summary.totalPnlUsd)}
              icon={TrendingUp}
              variant={summary.totalPnlUsd >= 0 ? "positive" : "negative"}
            />
            <KpiCard
              label="Avg Confidence"
              value={formatPct(summary.avgConfidence)}
              icon={Clock}
            />
          </div>

          {/* Accuracy bar */}
          <div className="rounded-lg border border-border bg-surface-1 p-4">
            <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
              Prediction Accuracy
            </h3>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <div className="flex h-5 rounded-full overflow-hidden bg-surface-2">
                  {summary.totalWindows > 0 && (
                    <>
                      <div
                        className="bg-positive transition-all flex items-center justify-center text-[10px] font-semibold text-white"
                        style={{ width: `${summary.accuracy * 100}%` }}
                      >
                        {summary.correctPredictions}
                      </div>
                      <div
                        className="bg-negative transition-all flex items-center justify-center text-[10px] font-semibold text-white"
                        style={{
                          width: `${(1 - summary.accuracy) * 100}%`,
                        }}
                      >
                        {summary.totalWindows - summary.correctPredictions}
                      </div>
                    </>
                  )}
                </div>
              </div>
              <span className="text-sm font-semibold text-text-primary tabular-nums">
                {(summary.accuracy * 100).toFixed(1)}%
              </span>
            </div>
          </div>

          {/* Regime Breakdown */}
          {regimeRows.length > 0 && (
            <div className="rounded-lg border border-border bg-surface-1 p-4">
              <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
                Performance by Regime
              </h3>
              <DataTable
                columns={[
                  {
                    key: "regime",
                    label: "Regime",
                    render: (r) => (
                      <span className="font-medium text-text-primary">
                        {r.regime}
                      </span>
                    ),
                  },
                  { key: "count", label: "Windows" },
                  { key: "correct", label: "Correct" },
                  {
                    key: "accuracy",
                    label: "Accuracy",
                    render: (r) => (
                      <span
                        className={
                          r.accuracy >= 0.5
                            ? "text-positive"
                            : "text-negative"
                        }
                      >
                        {formatPct(r.accuracy)}
                      </span>
                    ),
                  },
                  {
                    key: "pnlUsd",
                    label: "P&L",
                    render: (r) => <PnlBadge value={r.pnlUsd} />,
                  },
                ]}
                data={regimeRows}
              />
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center justify-center rounded-lg border border-border bg-surface-1 p-12">
          <p className="text-text-muted text-sm">
            No replay data yet. Run a replay to see results.
          </p>
        </div>
      )}
    </div>
  );
}
