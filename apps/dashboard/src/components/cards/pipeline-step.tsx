import clsx from "clsx";
import { Check, X, Loader2, Clock, SkipForward } from "lucide-react";
import { formatTimeAgo } from "@/lib/formatters";

type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";

interface PipelineStepProps {
  label: string;
  status: StepStatus;
  value?: string;
  confidence?: number;
  timestamp?: string;
  detail?: Record<string, unknown> | null;
}

const statusIcon: Record<StepStatus, { icon: typeof Check; color: string }> = {
  pending: { icon: Clock, color: "text-text-muted" },
  running: { icon: Loader2, color: "text-accent" },
  success: { icon: Check, color: "text-positive" },
  failed: { icon: X, color: "text-negative" },
  skipped: { icon: SkipForward, color: "text-text-muted" },
};

const statusBg: Record<StepStatus, string> = {
  pending: "border-border bg-surface-2",
  running: "border-accent/30 bg-accent/5",
  success: "border-positive/20 bg-positive/5",
  failed: "border-negative/20 bg-negative/5",
  skipped: "border-border bg-surface-2",
};

function valueColor(label: string, value?: string): string {
  if (!value) return "text-text-secondary";
  if (label === "Risk") return value === "passed" ? "text-positive" : "text-negative";
  if (label === "Supervisor") {
    if (value === "hold") return "text-text-muted";
    if (value.includes("up")) return "text-positive";
    if (value.includes("down")) return "text-negative";
  }
  if (label === "Regime") {
    if (value.includes("up")) return "text-positive";
    if (value.includes("down")) return "text-negative";
    if (value === "volatile") return "text-warning";
    if (value === "quiet") return "text-text-muted";
  }
  return "text-text-secondary";
}

export function PipelineStep({
  label,
  status,
  value,
  confidence,
  timestamp,
  detail,
}: PipelineStepProps) {
  const { icon: Icon, color } = statusIcon[status];

  return (
    <div className={clsx("rounded-lg border p-3 min-w-0", statusBg[status])}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <Icon
          className={clsx("h-4 w-4 shrink-0", color, status === "running" && "animate-spin")}
        />
        <span className="text-xs font-semibold text-text-primary uppercase tracking-wider">
          {label}
        </span>
      </div>

      {/* Value + confidence */}
      {value && (
        <div className="flex items-center gap-2 mb-1">
          <span className={clsx("text-sm font-bold", valueColor(label, value))}>
            {value}
          </span>
          {confidence !== undefined && confidence > 0 && (
            <span className="text-xs text-text-muted">
              {(confidence * 100).toFixed(0)}%
            </span>
          )}
        </div>
      )}

      {/* Risk detail */}
      {detail && label === "Risk" && (
        <div className="text-xs text-text-muted space-y-0.5">
          {detail.remainingBudgetUsd !== undefined && (
            <p>Budget: ${Number(detail.remainingBudgetUsd).toFixed(2)}</p>
          )}
          {detail.killSwitch && (
            <p className="text-negative font-medium">Kill switch ON</p>
          )}
        </div>
      )}

      {/* Execution detail */}
      {detail && label === "Execution" && (
        <div className="text-xs text-text-muted space-y-0.5">
          {detail.side && <p>Side: {String(detail.side)}</p>}
          {detail.sizeUsd !== undefined && <p>Size: ${Number(detail.sizeUsd).toFixed(2)}</p>}
          {detail.mode && <p>Mode: {String(detail.mode)}</p>}
        </div>
      )}

      {/* Timestamp */}
      {timestamp && (
        <p className="text-xs text-text-muted mt-1">
          {formatTimeAgo(timestamp)}
        </p>
      )}

      {/* No data state */}
      {!value && status === "pending" && (
        <p className="text-xs text-text-muted italic">Waiting...</p>
      )}
    </div>
  );
}
