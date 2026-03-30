import clsx from "clsx";

interface PnlBadgeProps {
  value: number;
  showSign?: boolean;
}

function formatPnl(value: number, showSign: boolean): string {
  const abs = Math.abs(value);
  const formatted = `$${abs.toFixed(2)}`;
  if (!showSign) return formatted;
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return formatted;
}

export function PnlBadge({ value, showSign = true }: PnlBadgeProps) {
  return (
    <span
      className={clsx(
        "text-sm font-medium tabular-nums",
        value > 0 && "text-positive",
        value < 0 && "text-negative",
        value === 0 && "text-text-muted",
      )}
    >
      {formatPnl(value, showSign)}
    </span>
  );
}
