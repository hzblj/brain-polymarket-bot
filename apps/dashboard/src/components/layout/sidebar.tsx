"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";
import {
  LayoutDashboard,
  CandlestickChart,
  Bot,
  ArrowRightLeft,
  FlaskConical,
  TrendingUp,
  RotateCcw,
  HeartPulse,
  SlidersHorizontal,
  Settings,
  ChevronLeft,
  ChevronRight,
  Waves,
  Flame,
  Microscope,
  BrainCircuit,
} from "lucide-react";

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/market", label: "Live Market", icon: CandlestickChart },
  { href: "/whales", label: "Whale Tracker", icon: Waves },
  { href: "/derivatives", label: "Derivatives", icon: Flame },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/trades", label: "Trades", icon: ArrowRightLeft },
  { href: "/simulation", label: "Simulation", icon: FlaskConical },
  { href: "/performance", label: "Performance", icon: TrendingUp },
  { href: "/trade-analysis", label: "Trade Analysis", icon: Microscope },
  { href: "/strategy-reports", label: "Strategy Reports", icon: BrainCircuit },
  { href: "/replay", label: "Replay", icon: RotateCcw },
  { href: "/health", label: "Health", icon: HeartPulse },
  { href: "/strategies", label: "Strategies", icon: SlidersHorizontal },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(true);

  return (
    <aside
      className={clsx(
        "glass flex flex-col h-full border-r transition-all duration-200 ease-in-out",
        expanded ? "w-[220px]" : "w-14",
      )}
    >
      {/* Toggle button */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center justify-center h-10 mt-1 mx-1 rounded text-text-muted hover:text-accent hover:bg-surface-2/50 transition-colors"
      >
        {expanded ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>

      {/* Nav links */}
      <nav className="flex-1 flex flex-col gap-0.5 px-1 py-1 overflow-y-auto">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/" ? pathname === "/" : pathname.startsWith(href);

          return (
            <Link
              key={href}
              href={href}
              title={label}
              className={clsx(
                "flex items-center gap-2.5 rounded px-2.5 py-2 text-xs transition-colors whitespace-nowrap overflow-hidden",
                active
                  ? "bg-accent/10 text-accent glow-accent-sm"
                  : "text-text-secondary hover:bg-surface-2/50 hover:text-text-primary",
              )}
            >
              <Icon size={16} className="shrink-0" />
              {expanded && <span>{label}</span>}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
