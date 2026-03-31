'use client';

import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge } from '@/components/badges/status-badge';
import { DataTable } from '@/components/tables/data-table';
import { useSystemConfig, useStrategies, useFeatureFlags } from '@/lib/hooks';
import { formatUsd, formatTimeAgo } from '@/lib/formatters';
import {
  switchStrategy,
  resetDefaultStrategy,
  toggleExecutionMode,
} from '@/lib/api';
import { Download } from 'lucide-react';

// ─── Types ─────────────────────────────────────────────────────────────────

type Strategy = {
  [key: string]: unknown;
  id: string;
  key: string;
  name: string;
  description: string;
  status: 'active' | 'inactive';
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

type VersionConfig = {
  id: string;
  label: string;
  marketSelector: { asset: string; marketType: string; windowSec: number };
  agentProfile: { regimeAgentProfile: string; edgeAgentProfile: string; supervisorAgentProfile: string };
  decisionPolicy: { allowedDecisions: string[]; minConfidence: number };
  filters: { maxSpreadBps: number; minDepthScore: number; minTimeToCloseSec: number; maxTimeToCloseSec: number };
  riskProfile: { maxSizeUsd: number; dailyLossLimitUsd: number; maxTradesPerWindow: number };
  executionPolicy: { entryWindowStartSec: number; entryWindowEndSec: number; mode: string };
};

type StrategyVersion = {
  id: string;
  strategyId: string;
  version: number;
  configJson: VersionConfig;
  checksum: string;
  createdAt: string;
};

const API_BASE =
  typeof window !== 'undefined'
    ? `http://${window.location.hostname}:3000`
    : 'http://localhost:3000';

const FLAG_LABELS: Record<string, string> = {
  agentRegimeEnabled: 'Agent Regime',
  agentEdgeEnabled: 'Agent Edge',
  agentSupervisorEnabled: 'Agent Supervisor',
  liveExecutionEnabled: 'Live Execution',
  replayEnabled: 'Replay',
  metricsEnabled: 'Metrics',
};

// ─── Page ──────────────────────────────────────────────────────────────────

export default function StrategiesPage() {
  const { data: config, refetch: refetchConfig } = useSystemConfig();
  const { data: strategies, refetch: refetchStrategies } = useStrategies();
  const { data: flags } = useFeatureFlags();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [versions, setVersions] = useState<StrategyVersion[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Fetch versions when a strategy is selected
  useEffect(() => {
    if (!selectedId) {
      setVersions([]);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);

    fetch(`${API_BASE}/api/v1/strategies/${selectedId}/versions`)
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled && json.ok) setVersions(json.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => { cancelled = true; };
  }, [selectedId]);

  const latestVersion = versions.length > 0 ? versions[versions.length - 1] : null;
  const cfg = latestVersion?.configJson;

  const selectedStrategy = (strategies as Strategy[] | null)?.find((s) => s.id === selectedId);

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleSwitch = useCallback(async () => {
    if (!selectedId || !latestVersion) return;
    setActionLoading(true);
    try {
      await switchStrategy('default', latestVersion.id);
      toast.success(`Switched to ${selectedStrategy?.name ?? selectedId}`);
      refetchStrategies();
      refetchConfig();
    } catch (err) {
      toast.error(`Switch failed: ${(err as Error).message}`);
    } finally {
      setActionLoading(false);
    }
  }, [selectedId, latestVersion, selectedStrategy, refetchStrategies, refetchConfig]);

  const handleReset = useCallback(async () => {
    setActionLoading(true);
    try {
      await resetDefaultStrategy();
      toast.success('Reset to default strategy');
      refetchStrategies();
      refetchConfig();
    } catch (err) {
      toast.error(`Reset failed: ${(err as Error).message}`);
    } finally {
      setActionLoading(false);
    }
  }, [refetchStrategies, refetchConfig]);

  const handleToggleMode = useCallback(async () => {
    const currentMode = (config as Record<string, Record<string, string>>)?.trading?.mode ?? 'disabled';
    setActionLoading(true);
    try {
      await toggleExecutionMode(currentMode);
      toast.success(currentMode === 'paper' ? 'Switched to LIVE' : 'Switched to PAPER');
      refetchConfig();
    } catch (err) {
      toast.error(`Toggle failed: ${(err as Error).message}`);
    } finally {
      setActionLoading(false);
    }
  }, [config, refetchConfig]);

  // ─── Render ────────────────────────────────────────────────────────────

  const tradingMode = (config as Record<string, Record<string, string>>)?.trading?.mode;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Strategies & Config"
        subtitle="Runtime configuration and strategy management"
        actions={
          <button
            type="button"
            onClick={async () => {
              try {
                const base = typeof window !== 'undefined' ? `http://${window.location.hostname}:3000` : '';
                const res = await fetch(`${base}/api/v1/config/export`);
                const json = await res.json();
                const blob = new Blob([JSON.stringify(json.data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `brain-config-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
              } catch (err) {
                toast.error(`Export failed: ${(err as Error).message}`);
              }
            }}
            className="flex items-center gap-1.5 rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-3 transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Export Config
          </button>
        }
      />

      {/* Row 1: Config + Feature Flags */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="rounded-lg border border-border bg-surface-1 p-4 lg:col-span-3">
          <h2 className="mb-3 text-sm font-semibold text-text-secondary uppercase tracking-wider">Current Config</h2>
          {config ? (
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <ConfigRow label="Execution Mode" value={<StatusBadge status={tradingMode as any} />} />
              <ConfigRow label="Max Size" value={formatUsd((config as any).trading?.maxSizeUsd ?? 0)} />
              <ConfigRow label="Daily Budget" value={formatUsd((config as any).risk?.dailyLossLimitUsd ?? 0)} />
              <ConfigRow label="Max Spread" value={`${(config as any).trading?.maxSpreadBps ?? '—'} bps`} />
              <ConfigRow label="LLM Provider" value={`${(config as any).provider?.provider ?? '—'} / ${(config as any).provider?.model ?? '—'}`} />
              <ConfigRow label="Resolver" value={(config as any).market?.resolver?.type ?? '—'} />
            </div>
          ) : (
            <p className="text-sm text-text-muted">Loading config...</p>
          )}
        </div>

        <div className="rounded-lg border border-border bg-surface-1 p-4 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-text-secondary uppercase tracking-wider">Feature Flags</h2>
          {flags ? (
            <div className="grid grid-cols-1 gap-2">
              {Object.entries(flags).map(([key, enabled]) => (
                <div key={key} className="flex items-center justify-between rounded border border-border bg-surface-2 px-3 py-2">
                  <span className="text-sm text-text-secondary">{FLAG_LABELS[key] ?? key}</span>
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${enabled ? 'bg-positive/10 text-positive' : 'bg-negative/10 text-negative'}`}>
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${enabled ? 'bg-positive' : 'bg-negative'}`} />
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

      {/* Row 2: Strategy List */}
      <div className="rounded-lg border border-border bg-surface-1 p-4">
        <h2 className="mb-3 text-sm font-semibold text-text-secondary uppercase tracking-wider">Strategies</h2>
        <DataTable<Strategy>
          columns={[
            { key: 'key', label: 'Key', render: (r) => <span className="font-mono text-accent">{r.key}</span> },
            { key: 'name', label: 'Name' },
            { key: 'description', label: 'Description', render: (r) => <span className="text-text-secondary text-xs">{r.description}</span> },
            {
              key: 'status',
              label: 'Status',
              render: (r) =>
                r.isDefault ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
                    Running
                  </span>
                ) : r.status === 'active' ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-positive/10 px-2 py-0.5 text-xs font-medium text-positive">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-positive" />
                    Available
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-text-muted">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-text-muted" />
                    Disabled
                  </span>
                ),
            },
            { key: 'createdAt', label: 'Created', render: (r) => <span className="text-text-muted text-xs">{formatTimeAgo(r.createdAt)}</span> },
          ]}
          data={(strategies as Strategy[]) ?? []}
          onRowClick={(row) => setSelectedId(selectedId === row.id ? null : row.id)}
          emptyMessage="No strategies found"
        />
      </div>

      {/* Row 3: Strategy Detail */}
      {selectedId && detailLoading && (
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <p className="text-sm text-text-muted">Loading strategy detail...</p>
        </div>
      )}

      {selectedId && cfg && !detailLoading && (
        <StrategyDetail
          strategy={selectedStrategy!}
          version={latestVersion!}
          cfg={cfg}
          actionLoading={actionLoading}
          onSwitch={handleSwitch}
          onClose={() => setSelectedId(null)}
          onSaved={() => {
            // Re-fetch versions
            setSelectedId(null);
            setTimeout(() => setSelectedId(selectedId), 100);
            refetchStrategies();
          }}
        />
      )}

      {/* Row 4: Actions */}
      <div className="rounded-lg border border-border bg-surface-1 p-4">
        <h2 className="mb-3 text-sm font-semibold text-text-secondary uppercase tracking-wider">Actions</h2>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={handleReset}
            disabled={actionLoading}
            className="rounded border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-3 disabled:opacity-40"
          >
            Reset to Default
          </button>
          <button
            onClick={handleToggleMode}
            disabled={actionLoading}
            className={`rounded px-4 py-2 text-sm font-semibold disabled:opacity-40 ${
              tradingMode === 'paper'
                ? 'border border-negative/30 bg-negative/10 text-negative hover:bg-negative/20'
                : 'border border-warning/30 bg-warning/10 text-warning hover:bg-warning/20'
            }`}
          >
            {tradingMode === 'paper' ? 'Switch to Live' : 'Switch to Paper'}
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

// ─── Editable Strategy Detail ──────────────────────────────────────────────

function StrategyDetail({
  strategy,
  version,
  cfg,
  actionLoading,
  onSwitch,
  onClose,
  onSaved,
}: {
  strategy: Strategy;
  version: StrategyVersion;
  cfg: VersionConfig;
  actionLoading: boolean;
  onSwitch: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<VersionConfig>(() => structuredClone(cfg));
  const [saving, setSaving] = useState(false);

  // Reset draft when cfg changes
  useEffect(() => {
    setDraft(structuredClone(cfg));
  }, [cfg]);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(cfg);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/strategies/${strategy.id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { ...draft, id: `${strategy.key}-v${version.version + 1}`, label: `${strategy.name} v${version.version + 1}` } }),
      });
      const json = await res.json();
      if (json.ok) {
        toast.success(`Saved as v${version.version + 1}`);
        onSaved();
      } else {
        toast.error('Save failed');
      }
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const updateFilter = (key: keyof VersionConfig['filters'], val: string) => {
    setDraft((d) => ({ ...d, filters: { ...d.filters, [key]: Number(val) } }));
  };
  const updateRisk = (key: keyof VersionConfig['riskProfile'], val: string) => {
    setDraft((d) => ({ ...d, riskProfile: { ...d.riskProfile, [key]: Number(val) } }));
  };
  const updateDecision = (key: keyof VersionConfig['decisionPolicy'], val: string | number) => {
    setDraft((d) => ({ ...d, decisionPolicy: { ...d.decisionPolicy, [key]: val } }));
  };
  const updateExecution = (key: keyof VersionConfig['executionPolicy'], val: string | number) => {
    setDraft((d) => ({ ...d, executionPolicy: { ...d.executionPolicy, [key]: val } }));
  };

  return (
    <div className="rounded-lg border border-accent/20 bg-surface-1 p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">
          {strategy.name} <span className="text-text-muted font-mono">v{version.version}</span>
        </h2>
        <div className="flex gap-2">
          {isDirty && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded bg-positive px-3 py-1 text-xs font-semibold text-white hover:bg-positive/80 disabled:opacity-40"
            >
              {saving ? 'Saving...' : `Save as v${version.version + 1}`}
            </button>
          )}
          {isDirty && (
            <button
              onClick={() => setDraft(structuredClone(cfg))}
              className="rounded border border-border px-3 py-1 text-xs font-medium text-text-secondary hover:bg-surface-2"
            >
              Discard
            </button>
          )}
          <button
            onClick={onSwitch}
            disabled={actionLoading || strategy.isDefault}
            className="rounded bg-accent px-3 py-1 text-xs font-semibold text-white hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {strategy.isDefault ? 'Currently Active' : 'Switch to This'}
          </button>
          <button onClick={onClose} className="text-xs text-text-muted hover:text-text-secondary">
            Close
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <DetailSection title="Market Selector">
          <DetailRow label="Asset" value={cfg.marketSelector.asset} />
          <DetailRow label="Market Type" value={cfg.marketSelector.marketType} />
          <DetailRow label="Window (sec)" value={String(cfg.marketSelector.windowSec)} />
        </DetailSection>

        <DetailSection title="Decision Policy">
          <DetailRow label="Allowed" value={draft.decisionPolicy.allowedDecisions.join(', ')} />
          <EditableRow label="Min Confidence" value={draft.decisionPolicy.minConfidence} onChange={(v) => updateDecision('minConfidence', Number(v))} step={0.05} min={0} max={1} />
        </DetailSection>

        <DetailSection title="Filters">
          <EditableRow label="Max Spread (bps)" value={draft.filters.maxSpreadBps} onChange={(v) => updateFilter('maxSpreadBps', v)} step={10} min={0} />
          <EditableRow label="Min Depth Score" value={draft.filters.minDepthScore} onChange={(v) => updateFilter('minDepthScore', v)} step={0.1} min={0} max={1} />
          <EditableRow label="Min Time Close (s)" value={draft.filters.minTimeToCloseSec} onChange={(v) => updateFilter('minTimeToCloseSec', v)} step={5} min={0} />
          <EditableRow label="Max Time Close (s)" value={draft.filters.maxTimeToCloseSec} onChange={(v) => updateFilter('maxTimeToCloseSec', v)} step={5} min={0} />
        </DetailSection>

        <DetailSection title="Risk Profile">
          <EditableRow label="Max Size ($)" value={draft.riskProfile.maxSizeUsd} onChange={(v) => updateRisk('maxSizeUsd', v)} step={0.1} min={0} />
          <EditableRow label="Daily Budget ($)" value={draft.riskProfile.dailyLossLimitUsd} onChange={(v) => updateRisk('dailyLossLimitUsd', v)} step={1} min={0} />
          <EditableRow label="Max Trades/Window" value={draft.riskProfile.maxTradesPerWindow} onChange={(v) => updateRisk('maxTradesPerWindow', v)} step={1} min={1} />
        </DetailSection>

        <DetailSection title="Execution Policy">
          <EditableRow label="Entry Start (s)" value={draft.executionPolicy.entryWindowStartSec} onChange={(v) => updateExecution('entryWindowStartSec', Number(v))} step={5} min={0} />
          <EditableRow label="Entry End (s)" value={draft.executionPolicy.entryWindowEndSec} onChange={(v) => updateExecution('entryWindowEndSec', Number(v))} step={1} min={0} />
          <DetailRow label="Mode" value={String(draft.executionPolicy.mode)} />
        </DetailSection>

        <DetailSection title="Agent Profiles">
          <DetailRow label="Regime" value={cfg.agentProfile.regimeAgentProfile} />
          <DetailRow label="Edge" value={cfg.agentProfile.edgeAgentProfile} />
          <DetailRow label="Supervisor" value={cfg.agentProfile.supervisorAgentProfile} />
        </DetailSection>
      </div>
    </div>
  );
}

function EditableRow({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (val: string) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-text-muted">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        step={step}
        min={min}
        max={max}
        className="w-24 rounded border border-border bg-surface-0 px-2 py-0.5 text-right font-mono text-sm text-text-primary focus:border-accent focus:outline-none"
      />
    </div>
  );
}
