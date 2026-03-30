"use client";

import { useState, useCallback } from "react";
import {
  Settings,
  Shield,
  ShieldOff,
  Zap,
  ZapOff,
  Pencil,
  Check,
  X,
  Monitor,
  Brain,
} from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { StatusBadge } from "@/components/badges/status-badge";
import { useSystemState } from "@/lib/hooks";
import { formatUsd } from "@/lib/formatters";

// ─── Types ──────────────────────────────────────────────────────────────────

type TradingMode = "paper" | "live" | "disabled";

type ConfirmAction =
  | "disable"
  | "paper"
  | "live"
  | "kill-activate"
  | "kill-deactivate"
  | null;

interface RiskConfig {
  maxSizeUsd: number;
  dailyLossLimitUsd: number;
  maxSpreadBps: number;
  minDepthScore: number;
  maxTradesPerWindow: number;
}

interface ProviderConfig {
  provider: string;
  model: string;
  temperature: number;
  timeout: number;
  maxRetries: number;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_RISK: RiskConfig = {
  maxSizeUsd: 500,
  dailyLossLimitUsd: 100,
  maxSpreadBps: 25,
  minDepthScore: 0.6,
  maxTradesPerWindow: 10,
};

const DEFAULT_PROVIDER: ProviderConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  temperature: 0.2,
  timeout: 30000,
  maxRetries: 3,
};

const RISK_LABELS: Record<keyof RiskConfig, string> = {
  maxSizeUsd: "Max Size USD",
  dailyLossLimitUsd: "Daily Loss Limit USD",
  maxSpreadBps: "Max Spread BPS",
  minDepthScore: "Min Depth Score",
  maxTradesPerWindow: "Max Trades Per Window",
};

// ─── Page ───────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const systemState = useSystemState();
  const state = systemState.data;

  // Trading mode
  const [mode, setMode] = useState<TradingMode>(
    (state?.mode as TradingMode) ?? "paper",
  );
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [liveConfirmText, setLiveConfirmText] = useState("");

  // Kill switch
  const [killSwitch, setKillSwitch] = useState(state?.killSwitch ?? false);

  // Risk config
  const [risk, setRisk] = useState<RiskConfig>(DEFAULT_RISK);
  const [editingField, setEditingField] = useState<keyof RiskConfig | null>(
    null,
  );
  const [editValue, setEditValue] = useState("");
  const [riskDirty, setRiskDirty] = useState(false);

  // Sync from server data when it arrives
  const currentMode: TradingMode =
    confirmAction === null && state?.mode
      ? (state.mode as TradingMode)
      : mode;
  const currentKillSwitch =
    confirmAction === null && state?.killSwitch !== undefined
      ? state.killSwitch
      : killSwitch;

  // ── Handlers ────────────────────────────────────────────────────────────

  const handleConfirm = useCallback(() => {
    if (confirmAction === "disable") {
      setMode("disabled");
    } else if (confirmAction === "paper") {
      setMode("paper");
    } else if (confirmAction === "live" && liveConfirmText === "LIVE") {
      setMode("live");
    } else if (confirmAction === "kill-activate") {
      setKillSwitch(true);
    } else if (confirmAction === "kill-deactivate") {
      setKillSwitch(false);
    }
    setConfirmAction(null);
    setLiveConfirmText("");
  }, [confirmAction, liveConfirmText]);

  const handleCancel = useCallback(() => {
    setConfirmAction(null);
    setLiveConfirmText("");
  }, []);

  const startEditField = (field: keyof RiskConfig) => {
    setEditingField(field);
    setEditValue(String(risk[field]));
  };

  const saveEditField = () => {
    if (editingField === null) return;
    const num = Number(editValue);
    if (!Number.isNaN(num)) {
      setRisk((prev) => ({ ...prev, [editingField]: num }));
      setRiskDirty(true);
    }
    setEditingField(null);
    setEditValue("");
  };

  const cancelEditField = () => {
    setEditingField(null);
    setEditValue("");
  };

  const handleSaveRisk = () => {
    // No real API call yet — just reset dirty flag
    setRiskDirty(false);
  };

  // ── Computed ────────────────────────────────────────────────────────────

  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
  const wsConnected = state?.wsConnected ?? false;

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader
        title="Settings"
        subtitle="Dashboard and system configuration"
      />

      {/* ── Row 1: Trading Mode + Kill Switch ──────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Trading Mode Control */}
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-text-secondary">
            Trading Mode Control
          </h2>

          <div className="mb-4 flex items-center gap-3">
            <span className="text-sm text-text-muted">Current Mode:</span>
            <StatusBadge status={currentMode} size="md" />
          </div>

          <div className="mb-4 space-y-1.5 text-xs text-text-muted">
            <p>
              <span className="font-medium text-text-secondary">
                Disabled:
              </span>{" "}
              All trading halted. No signals processed.
            </p>
            <p>
              <span className="font-medium text-text-secondary">Paper:</span>{" "}
              Signals processed and logged but no real orders placed.
            </p>
            <p>
              <span className="font-medium text-text-secondary">Live:</span>{" "}
              Real orders submitted to exchange. Use with caution.
            </p>
          </div>

          {/* Mode switch buttons */}
          {confirmAction === null && (
            <div className="flex flex-wrap gap-2">
              {currentMode !== "disabled" && (
                <button
                  type="button"
                  onClick={() => setConfirmAction("disable")}
                  className="rounded-md bg-warning/20 px-3 py-1.5 text-xs font-medium text-warning hover:bg-warning/30 transition-colors"
                >
                  <ZapOff className="mr-1.5 inline h-3.5 w-3.5" />
                  Disable Trading
                </button>
              )}
              {currentMode !== "paper" && (
                <button
                  type="button"
                  onClick={() => setConfirmAction("paper")}
                  className="rounded-md bg-accent/20 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/30 transition-colors"
                >
                  <Zap className="mr-1.5 inline h-3.5 w-3.5" />
                  Enable Paper Trading
                </button>
              )}
              {currentMode !== "live" && (
                <button
                  type="button"
                  onClick={() => setConfirmAction("live")}
                  className="rounded-md bg-negative/20 px-3 py-1.5 text-xs font-medium text-negative hover:bg-negative/30 transition-colors"
                >
                  <Zap className="mr-1.5 inline h-3.5 w-3.5" />
                  Enable Live Trading
                </button>
              )}
            </div>
          )}

          {/* Inline confirmations */}
          {confirmAction === "disable" && (
            <ConfirmBox
              message="Disable all trading?"
              onConfirm={handleConfirm}
              onCancel={handleCancel}
              variant="warning"
            />
          )}
          {confirmAction === "paper" && (
            <ConfirmBox
              message="Enable paper trading mode?"
              onConfirm={handleConfirm}
              onCancel={handleCancel}
              variant="accent"
            />
          )}
          {confirmAction === "live" && (
            <div className="rounded-md border border-negative/30 bg-negative/5 p-3">
              <p className="mb-2 text-sm font-medium text-negative">
                Enable LIVE trading? This will submit real orders.
              </p>
              <p className="mb-2 text-xs text-text-muted">
                Type <span className="font-mono font-bold text-negative">LIVE</span> to confirm:
              </p>
              <input
                type="text"
                value={liveConfirmText}
                onChange={(e) => setLiveConfirmText(e.target.value)}
                className="mb-2 w-full rounded border border-border bg-surface-0 px-2 py-1 text-sm text-text-primary placeholder:text-text-muted focus:border-negative focus:outline-none"
                placeholder="Type LIVE"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={liveConfirmText !== "LIVE"}
                  className="rounded-md bg-negative px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-negative/80"
                >
                  Confirm Live Mode
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="rounded-md bg-surface-3 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-2 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Kill Switch */}
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-text-secondary">
            Kill Switch
          </h2>

          <div className="mb-4 flex items-center gap-3">
            <span className="text-sm text-text-muted">Current State:</span>
            <div className="flex items-center gap-2">
              <span
                className={`h-3 w-3 rounded-full ${
                  currentKillSwitch ? "bg-negative animate-pulse" : "bg-positive"
                }`}
              />
              <span
                className={`text-sm font-semibold ${
                  currentKillSwitch ? "text-negative" : "text-positive"
                }`}
              >
                {currentKillSwitch ? "ACTIVE" : "Inactive"}
              </span>
            </div>
          </div>

          <p className="mb-4 text-xs text-text-muted">
            Kill switch immediately blocks all new trades and cancels pending
            orders. Use in emergency situations.
          </p>

          {confirmAction === null && (
            <div>
              {!currentKillSwitch ? (
                <button
                  type="button"
                  onClick={() => setConfirmAction("kill-activate")}
                  className="rounded-md bg-negative px-4 py-2 text-sm font-semibold text-white hover:bg-negative/80 transition-colors"
                >
                  <ShieldOff className="mr-1.5 inline h-4 w-4" />
                  Activate Kill Switch
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmAction("kill-deactivate")}
                  className="rounded-md bg-positive px-4 py-2 text-sm font-semibold text-white hover:bg-positive/80 transition-colors"
                >
                  <Shield className="mr-1.5 inline h-4 w-4" />
                  Deactivate Kill Switch
                </button>
              )}
            </div>
          )}

          {confirmAction === "kill-activate" && (
            <ConfirmBox
              message="Activate kill switch? All trading will be immediately halted."
              onConfirm={handleConfirm}
              onCancel={handleCancel}
              variant="negative"
            />
          )}
          {confirmAction === "kill-deactivate" && (
            <ConfirmBox
              message="Deactivate kill switch? Trading will resume based on current mode."
              onConfirm={handleConfirm}
              onCancel={handleCancel}
              variant="positive"
            />
          )}
        </div>
      </div>

      {/* ── Row 2: Risk Configuration ──────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-surface-1 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-text-secondary">
          Risk Configuration
        </h2>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {(Object.keys(RISK_LABELS) as (keyof RiskConfig)[]).map((field) => (
            <div
              key={field}
              className="rounded-lg border border-border bg-surface-2 px-3 py-2.5"
            >
              <div className="mb-1 text-xs text-text-muted">
                {RISK_LABELS[field]}
              </div>

              {editingField === field ? (
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="w-full rounded border border-border bg-surface-0 px-2 py-0.5 text-sm text-text-primary focus:border-accent focus:outline-none"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveEditField();
                      if (e.key === "Escape") cancelEditField();
                    }}
                  />
                  <button
                    type="button"
                    onClick={saveEditField}
                    className="rounded p-0.5 text-positive hover:bg-positive/10"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={cancelEditField}
                    className="rounded p-0.5 text-text-muted hover:bg-surface-3"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-text-primary">
                    {field === "maxSizeUsd" || field === "dailyLossLimitUsd"
                      ? formatUsd(risk[field])
                      : risk[field]}
                  </span>
                  <button
                    type="button"
                    onClick={() => startEditField(field)}
                    className="rounded p-0.5 text-text-muted hover:bg-surface-3 hover:text-text-secondary"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {riskDirty && (
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={handleSaveRisk}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/80 transition-colors"
            >
              Save Risk Configuration
            </button>
            <span className="text-xs text-text-muted">
              Unsaved changes
            </span>
          </div>
        )}
      </div>

      {/* ── Row 3: Dashboard Settings + Provider Config ────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Dashboard Settings */}
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-text-secondary">
            <Monitor className="mr-1.5 inline h-4 w-4" />
            Dashboard Settings
          </h2>

          <div className="space-y-3">
            <SettingsRow label="Theme">
              <select
                disabled
                className="rounded border border-border bg-surface-2 px-2 py-1 text-sm text-text-primary opacity-60"
              >
                <option>Dark</option>
              </select>
            </SettingsRow>

            <SettingsRow label="API URL">
              <span className="font-mono text-xs text-text-primary">
                {apiUrl}
              </span>
            </SettingsRow>

            <SettingsRow label="Refresh Rate">
              <div className="text-xs text-text-primary">
                <p>Live data: 2-5s</p>
                <p>Summaries: 10-30s</p>
              </div>
            </SettingsRow>

            <SettingsRow label="SSE Connection">
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${
                    wsConnected ? "bg-positive" : "bg-negative"
                  }`}
                />
                <span
                  className={`text-xs font-medium ${
                    wsConnected ? "text-positive" : "text-negative"
                  }`}
                >
                  {wsConnected ? "Connected" : "Disconnected"}
                </span>
              </div>
            </SettingsRow>
          </div>
        </div>

        {/* Provider Configuration */}
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-text-secondary">
            <Brain className="mr-1.5 inline h-4 w-4" />
            Provider Configuration
          </h2>

          <div className="space-y-3">
            <SettingsRow label="Provider">
              <span className="text-sm text-text-primary capitalize">
                {DEFAULT_PROVIDER.provider}
              </span>
            </SettingsRow>

            <SettingsRow label="Model">
              <span className="font-mono text-xs text-text-primary">
                {DEFAULT_PROVIDER.model}
              </span>
            </SettingsRow>

            <SettingsRow label="Temperature">
              <span className="text-sm text-text-primary">
                {DEFAULT_PROVIDER.temperature}
              </span>
            </SettingsRow>

            <SettingsRow label="Timeout">
              <span className="text-sm text-text-primary">
                {DEFAULT_PROVIDER.timeout}ms
              </span>
            </SettingsRow>

            <SettingsRow label="Max Retries">
              <span className="text-sm text-text-primary">
                {DEFAULT_PROVIDER.maxRetries}
              </span>
            </SettingsRow>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Helper Components ────────────────────────────────────────────────────────

function SettingsRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between rounded-md bg-surface-2 px-3 py-2">
      <span className="text-xs text-text-muted">{label}</span>
      <div className="text-right">{children}</div>
    </div>
  );
}

function ConfirmBox({
  message,
  onConfirm,
  onCancel,
  variant,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant: "warning" | "negative" | "positive" | "accent";
}) {
  const colorMap = {
    warning: {
      border: "border-warning/30",
      bg: "bg-warning/5",
      text: "text-warning",
      btn: "bg-warning text-white hover:bg-warning/80",
    },
    negative: {
      border: "border-negative/30",
      bg: "bg-negative/5",
      text: "text-negative",
      btn: "bg-negative text-white hover:bg-negative/80",
    },
    positive: {
      border: "border-positive/30",
      bg: "bg-positive/5",
      text: "text-positive",
      btn: "bg-positive text-white hover:bg-positive/80",
    },
    accent: {
      border: "border-accent/30",
      bg: "bg-accent/5",
      text: "text-accent",
      btn: "bg-accent text-white hover:bg-accent/80",
    },
  };

  const c = colorMap[variant];

  return (
    <div className={`rounded-md border ${c.border} ${c.bg} p-3`}>
      <p className={`mb-2 text-sm font-medium ${c.text}`}>{message}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${c.btn}`}
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md bg-surface-3 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-2 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
