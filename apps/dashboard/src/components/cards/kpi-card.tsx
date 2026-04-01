import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import clsx from "clsx";

interface KpiCardProps {
  label: string;
  value: string | number;
  subtitle?: ReactNode;
  delta?: number;
  icon?: LucideIcon;
  variant?: "default" | "positive" | "negative" | "warning";
}

const variantStyles = {
  default: "border-border",
  positive: "border-positive/30",
  negative: "border-negative/30",
  warning: "border-warning/30",
} as const;

export function KpiCard({
  label,
  value,
  subtitle,
  delta,
  icon: Icon,
  variant = "default",
}: KpiCardProps) {
  return (
    <div
      className={clsx(
        "rounded-lg border bg-surface-2/60 backdrop-blur-sm px-4 py-3 glow-accent-sm",
        variantStyles[variant],
      )}
    >
      <div className="flex items-start justify-between">
        <span className="text-xs font-medium text-text-muted">{label}</span>
        {Icon && <Icon className="h-4 w-4 text-text-muted" />}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-lg font-semibold text-text-primary truncate">
          {value}
        </span>
        {delta !== undefined && (
          <span
            className={clsx(
              "rounded-full px-1.5 py-0.5 text-xs font-medium",
              delta > 0 && "bg-positive/10 text-positive",
              delta < 0 && "bg-negative/10 text-negative",
              delta === 0 && "bg-surface-3 text-text-muted",
            )}
          >
            {delta > 0 ? "+" : ""}
            {delta}%
          </span>
        )}
      </div>
      {subtitle != null && (
        <div className="mt-0.5 text-xs text-text-secondary">{subtitle}</div>
      )}
    </div>
  );
}
