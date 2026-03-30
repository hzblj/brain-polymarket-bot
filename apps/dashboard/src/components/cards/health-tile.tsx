import clsx from "clsx";

interface HealthTileProps {
  name: string;
  status: "healthy" | "degraded" | "unhealthy";
  lastHeartbeat?: string;
  latencyMs?: number;
}

const dotColor = {
  healthy: "bg-positive",
  degraded: "bg-warning",
  unhealthy: "bg-negative",
} as const;

function formatAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

export function HealthTile({
  name,
  status,
  lastHeartbeat,
  latencyMs,
}: HealthTileProps) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-surface-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={clsx("h-2 w-2 rounded-full", dotColor[status])} />
        <span className="text-sm font-medium text-text-primary">{name}</span>
      </div>
      <div className="flex items-center gap-3 text-xs text-text-muted">
        {latencyMs !== undefined && <span>{latencyMs}ms</span>}
        {lastHeartbeat && <span>{formatAge(lastHeartbeat)}</span>}
      </div>
    </div>
  );
}
