'use client';

import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/badges/status-badge';
import { DataTable } from '@/components/tables/data-table';
import { useSystemConfig, useStrategies, useFeatureFlags } from '@/lib/hooks';
import { formatUsd, formatTimeAgo } from '@/lib/formatters';
import {
  getStrategyDetail,
  switchStrategy,
  resetDefaultStrategy,
  toggleExecutionMode,
} from '@/lib/api';

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

type StrategyDetail = {
  id: string;
  key: string;
  name: string;
  version: number;
  versionId: string;
  config: {
    marketSelector: { asset: string; marketType: string; windowSec: number };
    agentProfile: { regimeAgentProfile: string; edgeAgentProfile: string; supervisorAgentProfile: string };
    decisionPolicy: { allowedDecisions: string[]; minConfidence: number };
    filters: { maxSpreadBps: number; minDepthScore: number; minTimeToCloseSec: number; maxTimeToCloseSec: number };
    riskProfile: { maxSizeUsd: number; dailyLossLimitUsd: number; maxTradesPerWindow: number };
    executionPolicy: { entryWindowStartSec: number; entryWindowEndSec: number; mode: string };
  };
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
  const { data: config, refetch: refetchConfig } = useSystemConfig();
  const { data: strategies, refetch: refetchStrategies } = useStrategies();
  const { data: flags } = useFeatureFlags();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StrategyDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Fetch strategy detail when a row is selected
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);

    getStrategyDetail(selectedId)
      .then((data) => {
        if (!cancelled) setDetail(data as StrategyDetail | null);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => { cancelled = true; };
  }, [selectedId]);

  const handleConfirm = useCallback(async () => {
    setActionLoading(true);
    try {
      if (confirmAction === 'switch') {
        if (!selectedId || !detail) {
          toast.error('Select a strategy first.');
          return;
        }
        // Find the market config ID from strategies data, or use the versionId
        const strategyList = (strategies ?? []) as Strategy[];
        const selected = strategyList.find((s) => s.id === selectedId);
        if (!selected) {
          toast.error('Strategy not found.');
          return;
        }
        // Switch strategy: we need marketConfigId and strategyVersionId
        // The detail has versionId if available, otherwise use the strategy id
        await switchStrategy('default', detail.versionId ?? selectedId);
        toast.success(`Switched to ${selected.name}.`);
        refetchStrategies();
        refetchConfig();
      }

      if (confirmAction === 'reset') {
        await resetDefaultStrategy();
        toast.success('Config reset to default strategy.');
        refetchStrategies();
        refetchConfig();
      }

      if (confirmAction === 'toggle-mode') {
        const currentMode = (config as Record<string, Record<string, string>>)?.trading?.mode ?? 'disabled';
        await toggleExecutionMode(currentMode);
        toast.success(currentMode === 'paper' ? 'Switched to LIVE mode.' : 'Switched to PAPER mode.');
        refetchConfig();
      }
    } catch (err) {
      toast.error(`Action failed: ${(err as Error).message}`);
    } finally {
      setActionLoading(false);
      setConfirmAction(null);
    }
  }, [confirmAction, selectedId, detail, strategies, config, refetchStrategies, refetchConfig]);

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
      key: 'isDefault',
      label: 'Default',
      render: (row: Strategy) =>
        row.isDefault ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
            Active
          </span>
        ) : (
          <span className="text-xs text-text-muted">-</span>
        ),
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
                value={<StatusBadge status={(config as Record<string, Record<string, string>>).trading.mode} />}
              />
              <ConfigRow label="Max Size" value={formatUsd((config as Record<string, Record<string, number>>).trading.maxSizeUsd)} />
              <ConfigRow label="Daily Budget" value={formatUsd((config as Record<string, Record<string, number>>).risk.dailyLossLimitUsd)} />
              <ConfigRow label="Max Spread" value={`${(config as Record<string, Record<string, number>>).trading.maxSpreadBps} bps`} />
              <ConfigRow label="Edge Threshold (min)" value={String((config as Record<string, Record<string, number>>).trading.edgeThresholdMin)} />
              <ConfigRow label="Edge Threshold (strong)" value={String((config as Record<string, Record<string, number>>).trading.edgeThresholdStrong)} />
              <ConfigRow label="LLM Provider" value={`${(config as Record<string, Record<string, string>>).provider.provider} / ${(config as Record<string, Record<string, string>>).provider.model}`} />
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
      {selectedId && detailLoading && (
        <div className="rounded-lg border border-border-bright bg-surface-1 p-4">
          <p className="text-sm text-text-muted">Loading strategy detail...</p>
        </div>
      )}

      {selectedId && detail && !detailLoading && (
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
              <DetailRow label="Daily Budget" value={formatUsd(detail.config.riskProfile.dailyLossLimitUsd)} />
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
                  {(config as Record<string, Record<string, string>>)?.trading?.mode === 'paper'
                    ? 'Switch to LIVE execution? This will use REAL funds.'
                    : 'Switch to PAPER mode?'}
                </>
              )}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmAction(null)}
                disabled={actionLoading}
                className="rounded px-3 py-1 text-xs font-medium text-text-secondary hover:bg-surface-3 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={actionLoading}
                className={`rounded px-3 py-1 text-xs font-semibold disabled:opacity-40 ${
                  confirmAction === 'toggle-mode' && (config as Record<string, Record<string, string>>)?.trading?.mode === 'paper'
                    ? 'bg-negative text-white hover:bg-negative/80'
                    : 'bg-accent text-white hover:bg-accent/80'
                }`}
              >
                {actionLoading ? 'Processing...' : 'Confirm'}
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => setConfirmAction('switch')}
            disabled={!selectedId || !detail}
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
              (config as Record<string, Record<string, string>>)?.trading?.mode === 'paper'
                ? 'border border-negative/30 bg-negative/10 text-negative hover:bg-negative/20'
                : 'border border-warning/30 bg-warning/10 text-warning hover:bg-warning/20'
            }`}
          >
            {(config as Record<string, Record<string, string>>)?.trading?.mode === 'paper' ? 'Switch to Live' : 'Switch to Paper'}
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
