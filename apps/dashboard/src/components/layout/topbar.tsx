"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { Moon, Sun, Wifi, WifiOff, Zap, ZapOff } from "lucide-react";
import { useSystemState } from "@/lib/hooks";
import { useTheme } from "@/lib/theme";

function useClock() {
  const [time, setTime] = useState<string>("");

  useEffect(() => {
    const fmt = () =>
      new Date().toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    setTime(fmt());
    const id = setInterval(() => setTime(fmt()), 1_000);
    return () => clearInterval(id);
  }, []);

  return time;
}

const MODE_STYLES = {
  paper: "bg-warning/15 text-warning border-warning/30",
  live: "bg-positive/15 text-positive border-positive/30",
  disabled: "bg-text-muted/15 text-text-muted border-text-muted/30",
} as const;

export function Topbar() {
  const time = useClock();
  const { data: state } = useSystemState();
  const { theme, toggle } = useTheme();

  const mode = (state?.mode ?? "disabled") as keyof typeof MODE_STYLES;
  const market = state?.activeMarket?.label ?? "---";
  const strategy = state?.currentStrategy
    ? `${state.currentStrategy.key} v${state.currentStrategy.version}`
    : "---";
  const wsConnected = state?.wsConnected ?? false;
  const killSwitch = state?.killSwitch ?? false;

  return (
    <header className="glass flex items-center justify-between h-10 px-4 border-b shrink-0">
      {/* Left */}
      <div className="flex items-center gap-4">
        <span className="text-xs font-bold tracking-widest text-accent">
          BRAIN
        </span>

        <span
          className={clsx(
            "inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded border",
            MODE_STYLES[mode] ?? MODE_STYLES.disabled,
          )}
        >
          {mode}
        </span>

      </div>

      {/* Right */}
      <div className="flex items-center gap-3">
        {/* Theme toggle */}
        <button
          onClick={toggle}
          className="flex items-center justify-center w-6 h-6 rounded text-text-muted hover:text-accent hover:bg-surface-2/50 transition-colors"
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
        </button>

        {/* WebSocket status */}
        <div className="flex items-center gap-1.5 text-[10px]">
          {wsConnected ? (
            <>
              <Wifi size={12} className="text-positive" />
              <span className="text-text-muted">WS</span>
            </>
          ) : (
            <>
              <WifiOff size={12} className="text-negative" />
              <span className="text-negative">WS</span>
            </>
          )}
        </div>

        {/* Kill switch */}
        <div className="flex items-center gap-1.5 text-[10px]">
          {killSwitch ? (
            <>
              <ZapOff size={12} className="text-negative" />
              <span className="text-negative">KILL</span>
            </>
          ) : (
            <>
              <Zap size={12} className="text-accent" />
              <span className="text-text-muted">ACTIVE</span>
            </>
          )}
        </div>

        {/* Clock */}
        <span className="text-[11px] tabular-nums text-text-secondary w-16 text-right">
          {time}
        </span>
      </div>
    </header>
  );
}
