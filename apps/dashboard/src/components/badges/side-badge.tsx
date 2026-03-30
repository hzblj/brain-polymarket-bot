import clsx from "clsx";

interface SideBadgeProps {
  side: "buy_up" | "buy_down";
}

export function SideBadge({ side }: SideBadgeProps) {
  const isUp = side === "buy_up";

  return (
    <span
      className={clsx(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold",
        isUp ? "bg-positive/10 text-positive" : "bg-negative/10 text-negative",
      )}
    >
      {isUp ? "UP" : "DOWN"}
    </span>
  );
}
