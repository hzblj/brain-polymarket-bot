import { type ClassValue, clsx } from 'clsx';

/** Format number as USD: $1,234.56 */
export function formatUsd(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/** Format number as percentage: 64.3% */
export function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** Format PnL with sign: +$47.32 or -$18.40 */
export function formatPnl(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  const abs = Math.abs(n);
  return `${sign}$${abs.toFixed(2)}`;
}

/** Format milliseconds as duration: 2m 34s */
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;

  if (min === 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

/** Format ISO timestamp as relative time: "12s ago", "3m ago" */
export function formatTimeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

/** Format a price with configurable decimal places (default 2) */
export function formatPrice(n: number, decimals: number = 2): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Merge class names (clsx wrapper) */
export function cn(...classes: ClassValue[]): string {
  return clsx(...classes);
}
