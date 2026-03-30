'use client';

import { PageHeader } from '@/components/layout/page-header';
import { KpiCard } from '@/components/cards/kpi-card';
import { useTradeAnalyses } from '@/lib/hooks';
import { formatPnl, formatPct, formatTimeAgo } from '@/lib/formatters';
import { useState } from 'react';
import {
  Microscope,
  TrendingUp,
  TrendingDown,
  Target,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Lightbulb,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import clsx from 'clsx';

// ─── Helpers ────────────────────────────────────────────────────────────────

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface-2 ${className}`} />;
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const styles: Record<string, string> = {
    profitable: 'bg-positive/10 text-positive',
    unprofitable: 'bg-negative/10 text-negative',
    breakeven: 'bg-surface-3 text-text-muted',
    unknown: 'bg-surface-3 text-text-muted',
  };
  return (
    <span className={clsx('rounded-full px-2 py-0.5 text-xs font-medium', styles[verdict] ?? styles.unknown)}>
      {verdict}
    </span>
  );
}

function CalibrationBadge({ calibration }: { calibration: string }) {
  const styles: Record<string, string> = {
    well_calibrated: 'text-positive',
    overconfident: 'text-negative',
    underconfident: 'text-warning',
  };
  const labels: Record<string, string> = {
    well_calibrated: 'Well Calibrated',
    overconfident: 'Overconfident',
    underconfident: 'Underconfident',
  };
  return (
    <span className={clsx('text-xs font-medium', styles[calibration] ?? 'text-text-muted')}>
      {labels[calibration] ?? calibration}
    </span>
  );
}

function SideBadge({ side }: { side: string }) {
  return (
    <span
      className={clsx(
        'rounded px-1.5 py-0.5 text-xs font-medium',
        side === 'buy_up' ? 'bg-positive/10 text-positive' : 'bg-negative/10 text-negative',
      )}
    >
      {side === 'buy_up' ? 'UP' : 'DOWN'}
    </span>
  );
}

// ─── KPI Strip ──────────────────────────────────────────────────────────────

function AnalysisKpis() {
  const { data: analyses, isLoading } = useTradeAnalyses();

  if (isLoading) {
    return (
      <div className="grid grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }

  const all = analyses ?? [];
  const total = all.length;
  const profitable = all.filter((a) => a.verdict === 'profitable').length;
  const unprofitable = all.filter((a) => a.verdict === 'unprofitable').length;
  const totalPnl = all.reduce((sum, a) => sum + a.pnlUsd, 0);
  const edgeAccurateCount = all.filter((a) => a.edgeAccurate).length;
  const edgeAccuracy = total > 0 ? edgeAccurateCount / total : 0;
  const overconfidentCount = all.filter((a) => a.confidenceCalibration === 'overconfident').length;

  return (
    <div className="grid grid-cols-6 gap-3">
      <KpiCard label="Analyzed Trades" value={String(total)} icon={Microscope} />
      <KpiCard
        label="Total P&L"
        value={formatPnl(totalPnl)}
        variant={totalPnl >= 0 ? 'positive' : 'negative'}
        icon={totalPnl >= 0 ? TrendingUp : TrendingDown}
      />
      <KpiCard
        label="Profitable"
        value={String(profitable)}
        variant="positive"
        icon={CheckCircle2}
      />
      <KpiCard
        label="Unprofitable"
        value={String(unprofitable)}
        variant="negative"
        icon={XCircle}
      />
      <KpiCard
        label="Edge Accuracy"
        value={formatPct(edgeAccuracy)}
        variant={edgeAccuracy > 0.55 ? 'positive' : edgeAccuracy < 0.45 ? 'negative' : 'default'}
        icon={Target}
      />
      <KpiCard
        label="Overconfident"
        value={String(overconfidentCount)}
        variant={overconfidentCount > total * 0.3 ? 'warning' : 'default'}
        icon={AlertTriangle}
      />
    </div>
  );
}

// ─── Analysis Detail (expandable) ───────────────────────────────────────────

function AnalysisRow({
  analysis,
}: {
  analysis: NonNullable<ReturnType<typeof useTradeAnalyses>['data']>[number];
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-surface-1 overflow-hidden">
      {/* Summary row */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-4 px-4 py-3 text-left hover:bg-surface-2/30 transition-colors"
      >
        <VerdictBadge verdict={analysis.verdict} />
        <SideBadge side={analysis.side} />

        <span className="text-xs text-text-secondary font-mono">
          {analysis.regimeAtEntry}
        </span>

        <span
          className={clsx(
            'text-sm font-medium tabular-nums',
            analysis.pnlUsd >= 0 ? 'text-positive' : 'text-negative',
          )}
        >
          {formatPnl(analysis.pnlUsd)}
        </span>

        <span className="text-xs text-text-muted tabular-nums">
          edge: {analysis.edgeDirectionAtEntry} ({(analysis.edgeMagnitudeAtEntry * 100).toFixed(1)}%)
        </span>

        <span className="text-xs text-text-muted tabular-nums">
          conf: {(analysis.supervisorConfidence * 100).toFixed(0)}%
        </span>

        <span className="ml-auto flex items-center gap-2">
          {analysis.edgeAccurate ? (
            <CheckCircle2 size={14} className="text-positive" />
          ) : (
            <XCircle size={14} className="text-negative" />
          )}
          <CalibrationBadge calibration={analysis.confidenceCalibration} />
          <span className="text-xs text-text-muted">{formatTimeAgo(analysis.createdAt)}</span>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-border px-4 py-3 space-y-3 bg-surface-0">
          {/* Signals */}
          <div className="grid grid-cols-2 gap-4">
            {analysis.misleadingSignals.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-negative mb-1">
                  <AlertTriangle size={12} />
                  Misleading Signals
                </div>
                <ul className="space-y-0.5">
                  {analysis.misleadingSignals.map((s, i) => (
                    <li key={i} className="text-xs text-text-secondary font-mono pl-4">
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {analysis.correctSignals.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-positive mb-1">
                  <CheckCircle2 size={12} />
                  Correct Signals
                </div>
                <ul className="space-y-0.5">
                  {analysis.correctSignals.map((s, i) => (
                    <li key={i} className="text-xs text-text-secondary font-mono pl-4">
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Improvement suggestions */}
          {analysis.improvementSuggestions.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-accent mb-1">
                <Lightbulb size={12} />
                Improvement Suggestions
              </div>
              <ul className="space-y-0.5">
                {analysis.improvementSuggestions.map((s, i) => (
                  <li key={i} className="text-xs text-text-secondary pl-4">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* LLM Reasoning */}
          <div>
            <div className="text-xs font-medium text-text-muted mb-1">LLM Reasoning</div>
            <p className="text-xs text-text-secondary leading-relaxed">{analysis.llmReasoning}</p>
          </div>

          <div className="flex items-center gap-4 text-xs text-text-muted pt-1 border-t border-border">
            <span>Entry: {analysis.entryPrice.toFixed(3)}</span>
            <span>Exit: {analysis.exitPrice.toFixed(3)}</span>
            <span>Size: ${analysis.sizeUsd.toFixed(2)}</span>
            <span>P&L: {analysis.pnlBps.toFixed(0)} bps</span>
            <span>Model: {analysis.model}</span>
            <span>Latency: {analysis.latencyMs}ms</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Analysis List ──────────────────────────────────────────────────────────

function AnalysisList() {
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const { data: analyses, isLoading } = useTradeAnalyses(filter);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    );
  }

  const all = analyses ?? [];

  return (
    <div className="space-y-3">
      {/* Filter tabs */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-muted mr-1">Filter:</span>
        {[
          { label: 'All', value: undefined },
          { label: 'Unprofitable', value: 'unprofitable' },
          { label: 'Profitable', value: 'profitable' },
          { label: 'Breakeven', value: 'breakeven' },
        ].map(({ label, value }) => (
          <button
            key={label}
            onClick={() => setFilter(value)}
            className={clsx(
              'rounded px-2.5 py-1 text-xs font-medium transition-colors',
              filter === value
                ? 'bg-accent/10 text-accent'
                : 'bg-surface-2 text-text-secondary hover:text-text-primary',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* List */}
      {all.length === 0 ? (
        <div className="flex items-center justify-center rounded-lg border border-border bg-surface-1 p-12">
          <p className="text-text-muted text-sm">No trade analyses yet</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {all.map((a) => (
            <AnalysisRow key={a.id} analysis={a} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function TradeAnalysisPage() {
  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Trade Analysis"
        subtitle="LLM post-trade analysis: edge accuracy, signal quality, confidence calibration"
      />

      <AnalysisKpis />
      <AnalysisList />
    </div>
  );
}
