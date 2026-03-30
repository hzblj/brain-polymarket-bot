import clsx from "clsx";

interface StreakCardProps {
  label: string;
  value: number;
  type: "win" | "loss" | "neutral";
}

const typeStyles = {
  win: "border-positive/30 text-positive",
  loss: "border-negative/30 text-negative",
  neutral: "border-border text-text-muted",
} as const;

export function StreakCard({ label, value, type }: StreakCardProps) {
  return (
    <div
      className={clsx(
        "rounded-lg border bg-surface-2 px-3 py-2 text-center",
        typeStyles[type],
      )}
    >
      <span className="text-2xl font-bold tabular-nums">{value}</span>
      <p className="text-xs text-text-muted">{label}</p>
    </div>
  );
}
