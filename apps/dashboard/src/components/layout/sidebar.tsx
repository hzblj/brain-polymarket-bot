"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
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
  Terminal,
  Menu,
  X,
} from "lucide-react";

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/market", label: "Live Market", icon: CandlestickChart },
  { href: "/whales", label: "Whale Tracker", icon: Waves },
  { href: "/derivatives", label: "Derivatives", icon: Flame },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/logs", label: "Live Logs", icon: Terminal },
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
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Close on escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const navContent = (
    <nav className="flex-1 flex flex-col gap-0.5 px-1 py-1 overflow-y-auto">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active =
          href === "/" ? pathname === "/" : pathname.startsWith(href);

        return (
          <Link
            key={href}
            href={href}
            title={label}
            onClick={() => setMobileOpen(false)}
            className={clsx(
              "flex items-center gap-2.5 rounded px-2.5 py-2 text-xs transition-colors whitespace-nowrap overflow-hidden",
              active
                ? "bg-accent/10 text-accent glow-accent-sm"
                : "text-text-secondary hover:bg-surface-2/50 hover:text-text-primary",
            )}
          >
            <Icon size={16} className="shrink-0" />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={clsx(
          "glass flex-col h-full border-r transition-all duration-200 ease-in-out hidden lg:flex",
          expanded ? "w-[220px]" : "w-14",
        )}
      >
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center justify-center h-10 mt-1 mx-1 rounded text-text-muted hover:text-accent hover:bg-surface-2/50 transition-colors"
        >
          {expanded ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
        </button>
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

      {/* Mobile hamburger button */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed top-2 left-2 z-50 lg:hidden flex items-center justify-center w-8 h-8 rounded bg-surface-2/80 backdrop-blur-sm border border-border text-text-muted hover:text-accent transition-colors"
      >
        <Menu size={18} />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          onClick={() => setMobileOpen(false)}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <aside
            className="absolute left-0 top-0 h-full w-[260px] glass border-r flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between h-10 px-3 mt-1">
              <span className="text-xs font-bold tracking-widest text-accent">BRAIN</span>
              <button
                onClick={() => setMobileOpen(false)}
                className="flex items-center justify-center w-7 h-7 rounded text-text-muted hover:text-accent hover:bg-surface-2/50 transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            {navContent}
          </aside>
        </div>
      )}
    </>
  );
}
