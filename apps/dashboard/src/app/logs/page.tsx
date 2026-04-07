'use client';

import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Terminal, Brain, Zap, Eye, ChevronDown, ChevronRight } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { formatTimeAgo } from '@/lib/formatters';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TraceEntry {
  id: string;
  windowId: string;
  agentType: string;
  model: string;
  provider: string;
  userPrompt: string;
  rawResponse: string;
  parsedOutput: Record<string, unknown>;
  latencyMs: number;
  tokenUsage: { input: number; output: number };
  cached: boolean;
  createdAt: string;
}

interface PipelineStatus {
  enabled: boolean;
  running: boolean;
  cycleCount: number;
  lastResult: {
    cycle: number;
    timestamp: string;
    stage: string;
    details: Record<string, unknown>;
    durationMs: number;
  } | null;
}

// ─── Fetch functions ────────────────────────────────────────────────────────

function getApiBase(): string {
  if (typeof window !== 'undefined') return `http://${window.location.hostname}:3000`;
  return 'http://api-gateway:3000';
}

async function fetchTraces(limit: number): Promise<TraceEntry[]> {
  try {
    const res = await fetch(`${getApiBase()}/api/v1/agent/traces?limit=${limit}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data ?? []) as TraceEntry[];
  } catch {
    return [];
  }
}

async function fetchPipelineStatus(): Promise<PipelineStatus | null> {
  try {
    const res = await fetch(`${getApiBase()}/api/v1/pipeline/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return (json.data ?? null) as PipelineStatus | null;
  } catch {
    return null;
  }
}

// ─── Agent colors ───────────────────────────────────────────────────────────

const agentColors: Record<string, { bg: string; text: string; icon: typeof Brain }> = {
  regime: { bg: 'bg-purple-500/10 border-purple-500/20', text: 'text-purple-400', icon: Eye },
  edge: { bg: 'bg-blue-500/10 border-blue-500/20', text: 'text-blue-400', icon: Zap },
  supervisor: { bg: 'bg-amber-500/10 border-amber-500/20', text: 'text-amber-400', icon: Brain },
};

// ─── Log Entry Component ────────────────────────────────────────────────────

function LogEntry({ trace }: { trace: TraceEntry }) {
  const [expanded, setExpanded] = useState(false);
  const colors = agentColors[trace.agentType] ?? agentColors.regime;
  const Icon = colors.icon;
  const output = trace.parsedOutput;

  // Summary line based on agent type
  let summary = '';
  if (trace.agentType === 'regime') {
    summary = `${output.regime} (${((output.confidence as number) * 100).toFixed(0)}%)`;
  } else if (trace.agentType === 'edge') {
    summary = `${output.direction} mag=${output.magnitude} (${((output.confidence as number) * 100).toFixed(0)}%)`;
  } else if (trace.agentType === 'supervisor') {
    summary = `${output.action} $${output.sizeUsd ?? 0} (${((output.confidence as number) * 100).toFixed(0)}%)`;
  }

  return (
    <div className={`rounded-lg border ${colors.bg} p-3 transition-all`}>
      {/* Header row - always visible */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        )}
        <Icon className={`h-4 w-4 shrink-0 ${colors.text}`} />
        <span className={`text-xs font-bold uppercase tracking-wider ${colors.text}`}>
          {trace.agentType}
        </span>
        <span className="text-sm font-medium text-text-primary flex-1">
          {summary}
        </span>
        <div className="flex items-center gap-3 text-xs text-text-muted shrink-0">
          <span>{trace.latencyMs}ms</span>
          <span>{trace.tokenUsage.input + trace.tokenUsage.output} tok</span>
          <span>{trace.model}</span>
          <span>{formatTimeAgo(trace.createdAt)}</span>
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="mt-3 space-y-3">
          {/* Reasoning */}
          {Boolean(output.reasoning) && (
            <div className="rounded bg-surface-0/50 p-2">
              <p className="text-xs font-medium text-text-secondary mb-1">Reasoning</p>
              <p className="text-xs text-text-primary leading-relaxed">
                {String(output.reasoning)}
              </p>
            </div>
          )}

          {/* Full output */}
          <div className="rounded bg-surface-0/50 p-2">
            <p className="text-xs font-medium text-text-secondary mb-1">Output</p>
            <pre className="text-xs text-text-muted font-mono overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(output, null, 2)}
            </pre>
          </div>

          {/* Token usage */}
          <div className="flex gap-4 text-xs text-text-muted">
            <span>Input: {trace.tokenUsage.input} tokens</span>
            <span>Output: {trace.tokenUsage.output} tokens</span>
            <span>Latency: {trace.latencyMs}ms</span>
            <span>Model: {trace.provider}/{trace.model}</span>
            <span>Window: {trace.windowId}</span>
            {trace.cached && <span className="text-accent">Cached</span>}
          </div>

          {/* User prompt (collapsible) */}
          <details className="text-xs">
            <summary className="cursor-pointer text-text-muted hover:text-text-secondary">
              Show input prompt ({trace.userPrompt.length} chars)
            </summary>
            <pre className="mt-1 rounded bg-surface-0/50 p-2 text-text-muted font-mono overflow-x-auto whitespace-pre-wrap max-h-[300px] overflow-y-auto">
              {trace.userPrompt}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

// ─── Pipeline Status Bar ────────────────────────────────────────────────────

function PipelineStatusBar({ status }: { status: PipelineStatus | null }) {
  if (!status) return null;

  const result = status.lastResult;
  const stageColors: Record<string, string> = {
    skipped: 'text-text-muted',
    not_tradeable: 'text-warning',
    no_features: 'text-negative',
    agent_hold: 'text-blue-400',
    risk_rejected: 'text-negative',
    executed: 'text-positive',
    error: 'text-negative',
  };

  return (
    <div className="rounded-lg border border-border bg-surface-1 p-3 flex items-center gap-4 text-xs">
      <div className="flex items-center gap-2">
        <div className={`h-2 w-2 rounded-full ${status.running ? 'bg-accent animate-pulse' : 'bg-positive'}`} />
        <span className="text-text-secondary font-medium">Pipeline</span>
      </div>
      <span className="text-text-muted">Cycle #{status.cycleCount}</span>
      {result && (
        <>
          <span className={stageColors[result.stage] ?? 'text-text-muted'}>
            {result.stage}
          </span>
          <span className="text-text-muted">{result.durationMs}ms</span>
          {result.details.windowId && (
            <span className="text-text-muted">Window: {String(result.details.windowId)}</span>
          )}
          {result.details.reason && (
            <span className="text-text-muted italic">{String(result.details.reason)}</span>
          )}
          <span className="text-text-muted ml-auto">{formatTimeAgo(result.timestamp)}</span>
        </>
      )}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function LogsPage() {
  const [autoScroll, setAutoScroll] = useState(true);
  const [limit, setLimit] = useState(50);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());

  const tracesQuery = useQuery({
    queryKey: ['liveTraces', limit],
    queryFn: () => fetchTraces(limit),
    refetchInterval: 3_000,
  });

  const pipelineQuery = useQuery({
    queryKey: ['pipelineStatus'],
    queryFn: fetchPipelineStatus,
    refetchInterval: 2_000,
  });

  const traces = tracesQuery.data ?? [];

  // Track new entries for highlight effect
  useEffect(() => {
    const newIds = new Set(traces.map((t) => t.id));
    setSeenIds(newIds);
  }, [traces]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [traces, autoScroll]);

  // Group traces by window
  const tracesByWindow = new Map<string, TraceEntry[]>();
  for (const t of [...traces].reverse()) {
    const arr = tracesByWindow.get(t.windowId) ?? [];
    arr.push(t);
    tracesByWindow.set(t.windowId, arr);
  }

  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      <PageHeader
        title="Live Logs"
        subtitle="Real-time LLM agent decisions and pipeline activity"
        actions={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="rounded border-border bg-surface-2 text-accent h-3.5 w-3.5"
              />
              Auto-scroll
            </label>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text-primary"
            >
              <option value={20}>Last 20</option>
              <option value={50}>Last 50</option>
              <option value={100}>Last 100</option>
            </select>
          </div>
        }
      />

      {/* Pipeline status bar */}
      <PipelineStatusBar status={pipelineQuery.data ?? null} />

      {/* Log entries */}
      <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
        {traces.length === 0 && (
          <div className="flex items-center justify-center h-32 text-text-muted text-sm">
            <Terminal className="mr-2 h-4 w-4" />
            Waiting for agent traces...
          </div>
        )}

        {[...tracesByWindow.entries()].map(([windowId, windowTraces]) => (
          <div key={windowId}>
            <div className="flex items-center gap-2 my-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-text-muted px-2">Window {windowId}</span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <div className="space-y-2">
              {windowTraces.map((trace) => (
                <LogEntry key={trace.id} trace={trace} />
              ))}
            </div>
          </div>
        ))}

        <div ref={logEndRef} />
      </div>
    </div>
  );
}
