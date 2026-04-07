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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  detail?: Record<string, any> | null;
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
    if (value === "hold") return "text-warning";
    if (value.includes("up")) return "text-positive";
    if (value.includes("down")) return "text-negative";
  }
  if (label === "Edge") {
    if (value === "none") return "text-warning";
    if (value === "up") return "text-positive";
    if (value === "down") return "text-negative";
  }
  if (label === "Regime") {
    if (value.includes("up")) return "text-positive";
    if (value.includes("down")) return "text-negative";
    if (value === "volatile") return "text-negative";
    if (value === "quiet") return "text-warning";
    if (value === "mean_reverting") return "text-accent";
  }
  return "text-text-secondary";
}

function confidenceColor(confidence: number): string {
  if (confidence >= 0.8) return "text-positive font-bold";
  if (confidence >= 0.66) return "text-accent font-semibold";
  if (confidence >= 0.5) return "text-warning font-semibold";
  return "text-text-muted";
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
    <div className={clsx("rounded-lg border p-3 min-w-0 min-h-[88px]", statusBg[status], value === 'skipped' && "opacity-40")}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-1.5">
        <Icon
          className={clsx("h-4 w-4 shrink-0", color, status === "running" && "animate-spin")}
        />
        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
          {label}
        </span>
      </div>

      {/* Value — large and bold */}
      {value && (
        <p className={clsx("text-lg font-black leading-tight tracking-tight", valueColor(label, value))}>
          {value}
        </p>
      )}

      {/* Confidence — prominent */}
      {confidence !== undefined && confidence > 0 && (
        <p className={clsx("text-sm mt-0.5", confidenceColor(confidence))}>
          {(confidence * 100).toFixed(0)}%
        </p>
      )}

      {/* Risk detail */}
      {detail && label === "Risk" && (
        <div className="text-xs text-text-muted mt-1 space-y-0.5">
          {detail.remainingBudgetUsd !== undefined && (
            <p>Budget: <span className="text-text-primary font-medium">${Number(detail.remainingBudgetUsd).toFixed(2)}</span></p>
          )}
          {detail.killSwitch && (
            <p className="text-negative font-bold">KILL SWITCH ON</p>
          )}
        </div>
      )}

      {/* Execution detail */}
      {detail && label === "Execution" && (
        <div className="text-xs text-text-muted mt-1 space-y-0.5">
          {detail.side && <p>Side: <span className="text-text-primary font-medium">{String(detail.side)}</span></p>}
          {detail.sizeUsd !== undefined && <p>Size: <span className="text-text-primary font-medium">${Number(detail.sizeUsd).toFixed(2)}</span></p>}
          {detail.mode && <p>Mode: <span className="text-text-primary font-medium">{String(detail.mode)}</span></p>}
        </div>
      )}

      {/* Timestamp */}
      {timestamp && (
        <p className="text-[10px] text-text-muted mt-1.5">
          {formatTimeAgo(timestamp)}
        </p>
      )}

      {/* No data state */}
      {!value && status === "pending" && (
        <p className="text-sm text-text-muted italic mt-1">Waiting...</p>
      )}
    </div>
  );
}
