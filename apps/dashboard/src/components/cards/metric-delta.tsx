import clsx from "clsx";
import { ArrowUp, ArrowDown } from "lucide-react";

interface MetricDeltaProps {
  label: string;
  current: number;
  previous: number;
  format?: "number" | "percent" | "currency";
}

function formatValue(value: number, format: "number" | "percent" | "currency"): string {
  switch (format) {
    case "currency":
      return `$${value.toFixed(2)}`;
    case "percent":
      return `${value.toFixed(1)}%`;
    default:
      return value.toLocaleString();
  }
}

export function MetricDelta({
  label,
  current,
  previous,
  format = "number",
}: MetricDeltaProps) {
  const diff = current - previous;
  const pctChange = previous !== 0 ? (diff / Math.abs(previous)) * 100 : 0;
  const isPositive = diff > 0;
  const isNegative = diff < 0;

  return (
    <div className="space-y-0.5">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="text-lg font-semibold text-text-primary tabular-nums">
        {formatValue(current, format)}
      </p>
      <div
        className={clsx(
          "flex items-center gap-1 text-xs font-medium",
          isPositive && "text-positive",
          isNegative && "text-negative",
          !isPositive && !isNegative && "text-text-muted",
        )}
      >
        {isPositive && <ArrowUp className="h-3 w-3" />}
        {isNegative && <ArrowDown className="h-3 w-3" />}
        <span className="tabular-nums">
          {isPositive ? "+" : ""}
          {pctChange.toFixed(1)}%
        </span>
        <span className="text-text-muted">vs prev</span>
      </div>
    </div>
  );
}
