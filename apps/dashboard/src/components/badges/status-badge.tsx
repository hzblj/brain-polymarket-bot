import clsx from "clsx";

type Status =
  | "healthy"
  | "degraded"
  | "unhealthy"
  | "active"
  | "inactive"
  | "paper"
  | "live"
  | "disabled";

interface StatusBadgeProps {
  status: Status;
  size?: "sm" | "md";
}

const statusConfig: Record<Status, { dot: string; bg: string; text: string; label: string }> = {
  healthy:   { dot: "bg-positive",  bg: "bg-positive/10", text: "text-positive",  label: "Healthy" },
  active:    { dot: "bg-positive",  bg: "bg-positive/10", text: "text-positive",  label: "Active" },
  live:      { dot: "bg-positive",  bg: "bg-positive/10", text: "text-positive",  label: "Live" },
  degraded:  { dot: "bg-warning",   bg: "bg-warning/10",  text: "text-warning",   label: "Degraded" },
  paper:     { dot: "bg-warning",   bg: "bg-warning/10",  text: "text-warning",   label: "Paper" },
  unhealthy: { dot: "bg-negative",  bg: "bg-negative/10", text: "text-negative",  label: "Unhealthy" },
  disabled:  { dot: "bg-negative",  bg: "bg-negative/10", text: "text-negative",  label: "Disabled" },
  inactive:  { dot: "bg-negative",  bg: "bg-negative/10", text: "text-negative",  label: "Inactive" },
};

export function StatusBadge({ status, size = "sm" }: StatusBadgeProps) {
  const cfg = statusConfig[status];

  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full font-medium",
        cfg.bg,
        cfg.text,
        size === "sm" && "px-2 py-0.5 text-xs",
        size === "md" && "px-2.5 py-1 text-sm",
      )}
    >
      <span className={clsx("inline-block rounded-full", cfg.dot, size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2")} />
      {cfg.label}
    </span>
  );
}
