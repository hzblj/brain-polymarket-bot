import clsx from "clsx";
import { Check, X, Loader2, Clock, SkipForward, ArrowRight } from "lucide-react";

type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";

interface PipelineStepProps {
  label: string;
  status: StepStatus;
  value?: string;
  confidence?: number;
  timestamp?: string;
  isLast?: boolean;
}

const statusIcon: Record<StepStatus, { icon: typeof Check; color: string }> = {
  pending: { icon: Clock, color: "text-text-muted" },
  running: { icon: Loader2, color: "text-accent" },
  success: { icon: Check, color: "text-positive" },
  failed: { icon: X, color: "text-negative" },
  skipped: { icon: SkipForward, color: "text-text-muted" },
};

export function PipelineStep({
  label,
  status,
  value,
  confidence,
  timestamp,
  isLast = false,
}: PipelineStepProps) {
  const { icon: Icon, color } = statusIcon[status];

  return (
    <div className="flex items-center">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2">
        <Icon
          className={clsx("h-4 w-4", color, status === "running" && "animate-spin")}
        />
        <div className="min-w-0">
          <p className="text-xs font-medium text-text-primary">{label}</p>
          <div className="flex items-center gap-2">
            {value && (
              <span className="text-xs text-text-secondary">{value}</span>
            )}
            {confidence !== undefined && (
              <span className="text-xs text-text-muted">
                {(confidence * 100).toFixed(0)}%
              </span>
            )}
            {timestamp && (
              <span className="text-xs text-text-muted">{timestamp}</span>
            )}
          </div>
        </div>
      </div>
      {!isLast && (
        <ArrowRight className="mx-1 h-3.5 w-3.5 shrink-0 text-text-muted" />
      )}
    </div>
  );
}
