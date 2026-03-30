'use client';

import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/badges/status-badge';
import { DataTable } from '@/components/tables/data-table';
import { useSystemConfig, useStrategies, useFeatureFlags } from '@/lib/hooks';
import { formatUsd, formatTimeAgo } from '@/lib/formatters';
import { getStrategyDetail } from '@/lib/api';

// ─── Types ─────────────────────────────────────────────────────────────────

type ConfirmAction = 'switch' | 'reset' | 'toggle-mode' | null;

type Strategy = {
  [key: string]: unknown;
  id: string;
  key: string;
  name: string;
  description: string;
  status: 'active' | 'inactive';
  isDefault: boolean;
  latestVersion: number;
  createdAt: string;
  updatedAt: string;
};

const FLAG_LABELS: Record<string, string> = {
  agentRegimeEnabled: 'Agent Regime Enabled',
  agentEdgeEnabled: 'Agent Edge Enabled',
  agentSupervisorEnabled: 'Agent Supervisor Enabled',
  liveExecutionEnabled: 'Live Execution Enabled',
  replayEnabled: 'Replay Enabled',
  metricsEnabled: 'Metrics Enabled',
};

// ─── Page ──────────────────────────────────────────────────────────────────

export default function StrategiesPage() {
  const { data: config } = useSystemConfig();
  const { data: strategies } = useStrategies();
  const { data: flags } = useFeatureFlags();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  const handleConfirm = useCallback(() => {
    if (confirmAction === 'switch') toast.success('Strategy switched successfully.');
    if (confirmAction === 'reset') toast.success('Config reset to BTC 5m default.');
    if (confirmAction === 'toggle-mode') toast.success('Execution mode toggled.');
    setConfirmAction(null);
  }, [confirmAction]);

  const detail = selectedId ? null : null; // TODO: fetch via getStrategyDetail(selectedId) when strategies API is implemented

  // ─── Strategy table columns ────────────────────────────────────────────

  const columns = [
    { key: 'key', label: 'Strategy Key' },
    { key: 'name', label: 'Name' },
    {
      key: 'latestVersion',
      label: 'Version',
      render: (row: Strategy) => <span className="font-mono text-text-secondary">v{row.latestVersion}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      render: (row: Strategy) => <StatusBadge status={row.status} />,
    },
    {
      key: 'createdAt',
      label: 'Created',
      render: (row: Strategy) => <span className="text-text-secondary">{formatTimeAgo(row.createdAt)}</span>,
    },
  ];

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader title="Strategies & Config" subtitle="Runtime configuration and strategy management" />

      {/* ── Row 1: Current Config + Feature Flags ─────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Current Config Panel (60%) */}
        <div className="rounded-lg border border-border bg-surface-1 p-4 lg:col-span-3">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Current Config</h2>
          {config ? (
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <ConfigRow label="Asset" value="BTC" />
              <ConfigRow label="Market Type" value="binary" />
              <ConfigRow label="Window Duration" value="300s (5m)" />
              <ConfigRow label="Resolver Type" value="binance_spot" />
              <ConfigRow
                label="Execution Mode"
                value={<StatusBadge status={config.trading.mode} />}
              />
              <ConfigRow label="Active Strategy" value="btc_5m_momentum_v1" />
              <ConfigRow label="Strategy Version" value="v3" />
              <ConfigRow label="Max Size" value={formatUsd(config.trading.maxSizeUsd)} />
              <ConfigRow label="Max Spread" value={`${config.trading.maxSpreadBps} bps`} />
              <ConfigRow label="Edge Threshold (min)" value={String(config.trading.edgeThresholdMin)} />
              <ConfigRow label="Edge Threshold (strong)" value={String(config.trading.edgeThresholdStrong)} />
              <ConfigRow label="LLM Provider" value={`${config.provider.provider} / ${config.provider.model}`} />
            </div>
          ) : (
            <p className="text-sm text-text-muted">Loading config...</p>
          )}
        </div>

        {/* Feature Flags Panel (40%) */}
        <div className="rounded-lg border border-border bg-surface-1 p-4 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Feature Flags</h2>
          {flags ? (
            <div className="grid grid-cols-1 gap-2">
              {Object.entries(flags).map(([key, enabled]) => (
                <div
                  key={key}
                  className="flex items-center justify-between rounded border border-border bg-surface-2 px-3 py-2"
                >
                  <span className="text-sm text-text-secondary">{FLAG_LABELS[key] ?? key}</span>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
                      enabled
                        ? 'bg-positive/10 text-positive'
                        : 'bg-negative/10 text-negative'
                    }`}
                  >
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        enabled ? 'bg-positive' : 'bg-negative'
                      }`}
                    />
                    {enabled ? 'ON' : 'OFF'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-muted">Loading flags...</p>
          )}
        </div>
      </div>

      {/* ── Row 2: Strategy List ──────────────────────────────────────────── */}
      <div>
        <h2 className="mb-2 text-sm font-semibold text-text-primary">Strategies</h2>
        <DataTable<Strategy>
          columns={columns}
          data={(strategies as Strategy[]) ?? []}
          onRowClick={(row) => setSelectedId(selectedId === row.id ? null : row.id)}
          emptyMessage="No strategies found"
        />
      </div>

      {/* ── Row 3: Strategy Detail (expandable) ──────────────────────────── */}
      {selectedId && detail && (
        <div className="rounded-lg border border-border-bright bg-surface-1 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">
              Strategy Detail: <span className="font-mono text-accent">{detail.key}</span>{' '}
              <span className="text-text-muted">v{detail.version}</span>
            </h2>
            <button
              onClick={() => setSelectedId(null)}
              className="text-xs text-text-muted hover:text-text-secondary"
            >
              Close
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {/* Market Selector */}
            <DetailSection title="Market Selector">
              <DetailRow label="Asset" value={detail.config.marketSelector.asset} />
              <DetailRow label="Market Type" value={detail.config.marketSelector.marketType} />
              <DetailRow label="Window (sec)" value={String(detail.config.marketSelector.windowSec)} />
            </DetailSection>

            {/* Decision Policy */}
            <DetailSection title="Decision Policy">
              <DetailRow label="Allowed Decisions" value={detail.config.decisionPolicy.allowedDecisions.join(', ')} />
              <DetailRow label="Min Confidence" value={String(detail.config.decisionPolicy.minConfidence)} />
            </DetailSection>

            {/* Filters */}
            <DetailSection title="Filters">
              <DetailRow label="Max Spread (bps)" value={String(detail.config.filters.maxSpreadBps)} />
              <DetailRow label="Min Depth Score" value={String(detail.config.filters.minDepthScore)} />
              <DetailRow label="Min Time to Close (s)" value={String(detail.config.filters.minTimeToCloseSec)} />
              <DetailRow label="Max Time to Close (s)" value={String(detail.config.filters.maxTimeToCloseSec)} />
            </DetailSection>

            {/* Risk Profile */}
            <DetailSection title="Risk Profile">
              <DetailRow label="Max Size" value={formatUsd(detail.config.riskProfile.maxSizeUsd)} />
              <DetailRow label="Daily Loss Limit" value={formatUsd(detail.config.riskProfile.dailyLossLimitUsd)} />
              <DetailRow label="Max Trades / Window" value={String(detail.config.riskProfile.maxTradesPerWindow)} />
            </DetailSection>

            {/* Execution Policy */}
            <DetailSection title="Execution Policy">
              <DetailRow label="Entry Window Start (s)" value={String(detail.config.executionPolicy.entryWindowStartSec)} />
              <DetailRow label="Entry Window End (s)" value={String(detail.config.executionPolicy.entryWindowEndSec)} />
              <DetailRow label="Mode" value={detail.config.executionPolicy.mode} />
            </DetailSection>

            {/* Agent Profiles */}
            <DetailSection title="Agent Profiles">
              <DetailRow label="Regime" value={detail.config.agentProfile.regimeAgentProfile} />
              <DetailRow label="Edge" value={detail.config.agentProfile.edgeAgentProfile} />
              <DetailRow label="Supervisor" value={detail.config.agentProfile.supervisorAgentProfile} />
            </DetailSection>
          </div>
        </div>
      )}

      {/* ── Row 4: Actions ────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-surface-1 p-4">
        <h2 className="mb-3 text-sm font-semibold text-text-primary">Actions</h2>

        {/* Confirmation banner */}
        {confirmAction && (
          <div className="mb-3 flex items-center justify-between rounded border border-warning/30 bg-warning/10 px-4 py-2.5">
            <span className="text-sm font-medium text-warning">
              {confirmAction === 'switch' && 'Switch to the selected strategy?'}
              {confirmAction === 'reset' && 'Reset config to BTC 5m default preset?'}
              {confirmAction === 'toggle-mode' && (
                <>
                  {config?.trading.mode === 'paper'
                    ? 'Switch to LIVE execution? This will use REAL funds.'
                    : 'Switch to PAPER mode?'}
                </>
              )}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmAction(null)}
                className="rounded px-3 py-1 text-xs font-medium text-text-secondary hover:bg-surface-3"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                className={`rounded px-3 py-1 text-xs font-semibold ${
                  confirmAction === 'toggle-mode' && config?.trading.mode === 'paper'
                    ? 'bg-negative text-white hover:bg-negative/80'
                    : 'bg-accent text-white hover:bg-accent/80'
                }`}
              >
                Confirm
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => setConfirmAction('switch')}
            disabled={!selectedId}
            className="rounded border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Switch Active Strategy
          </button>
          <button
            onClick={() => setConfirmAction('reset')}
            className="rounded border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-3"
          >
            Reset to Default (BTC 5m)
          </button>
          <button
            onClick={() => setConfirmAction('toggle-mode')}
            className={`rounded px-4 py-2 text-sm font-semibold ${
              config?.trading.mode === 'paper'
                ? 'border border-negative/30 bg-negative/10 text-negative hover:bg-negative/20'
                : 'border border-warning/30 bg-warning/10 text-warning hover:bg-warning/20'
            }`}
          >
            {config?.trading.mode === 'paper' ? 'Switch to Live' : 'Switch to Paper'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ConfigRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border/50 py-1.5 last:border-b-0">
      <span className="text-text-muted">{label}</span>
      <span className="font-medium text-text-primary">{value}</span>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-border bg-surface-2 p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h3>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-text-muted">{label}</span>
      <span className="font-mono text-text-secondary">{value}</span>
    </div>
  );
}
