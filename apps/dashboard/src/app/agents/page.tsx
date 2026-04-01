"use client";

import { useState } from "react";
import { Bot, Brain, Crosshair, Eye, Clock, Zap, ShieldCheck, ShieldAlert, Wrench } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { KpiCard } from "@/components/cards/kpi-card";
import { useAgentTraces, useAgentContext, usePipeline } from "@/lib/hooks";
import { formatTimeAgo } from "@/lib/formatters";
import type { AgentTrace } from "@/lib/api";

type AgentFilter = "all" | "regime" | "edge" | "supervisor" | "validator" | "gatekeeper" | "eval";

const FILTER_LABELS: Record<AgentFilter, string> = {
  all: "All",
  regime: "Regime",
  edge: "Edge",
  supervisor: "Supervisor",
  validator: "Validator",
  gatekeeper: "Gatekeeper",
  eval: "Eval",
};

const AGENT_ICONS: Record<string, typeof Brain> = {
  regime: Brain,
  edge: Crosshair,
  supervisor: Eye,
  validator: ShieldCheck,
  gatekeeper: ShieldAlert,
  eval: Wrench,
};

const AGENT_COLORS: Record<string, string> = {
  regime: "text-accent",
  edge: "text-warning",
  supervisor: "text-positive",
  validator: "text-text-secondary",
  gatekeeper: "text-negative",
  eval: "text-accent",
};

export default function AgentsPage() {
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: traces } = useAgentTraces(filter === "all" ? undefined : filter);
  const { data: context } = useAgentContext();
  const { data: pipeline } = usePipeline();

  const filteredTraces = traces ?? [];

  // KPI computation
  const totalTraces = filteredTraces.length;
  const avgLatency = totalTraces > 0
    ? Math.round(filteredTraces.reduce((s, t) => s + t.latencyMs, 0) / totalTraces)
    : 0;
  const regimeCount = filteredTraces.filter((t) => t.agentType === "regime").length;
  const edgeCount = filteredTraces.filter((t) => t.agentType === "edge").length;
  const supervisorCount = filteredTraces.filter((t) => t.agentType === "supervisor").length;
  const validatorCount = filteredTraces.filter((t) => t.agentType === "validator").length;
  const gatekeeperCount = filteredTraces.filter((t) => t.agentType === "gatekeeper").length;
  const evalCount = filteredTraces.filter((t) => t.agentType === "eval").length;
  const lastTrace = filteredTraces[0];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Agents"
        subtitle="LLM agent decision traces and pipeline visibility"
      />

      {/* KPI Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <KpiCard label="Total Traces" value={totalTraces} icon={Bot} />
        <KpiCard label="Avg Latency" value={`${avgLatency}ms`} icon={Zap} />
        <KpiCard label="Regime" value={regimeCount} icon={Brain} variant="default" />
        <KpiCard label="Edge" value={edgeCount} icon={Crosshair} variant="warning" />
        <KpiCard label="Supervisor" value={supervisorCount} icon={Eye} variant="positive" />
        <KpiCard label="Validator" value={validatorCount} icon={ShieldCheck} variant="default" />
        <KpiCard label="Gatekeeper" value={gatekeeperCount} icon={ShieldAlert} variant="negative" />
        <KpiCard label="Eval" value={evalCount} icon={Wrench} variant="default" />
        <KpiCard
          label="Last Decision"
          value={lastTrace ? formatTimeAgo(lastTrace.createdAt) : "—"}
          icon={Clock}
        />
      </div>

      {/* Pipeline Context */}
      {pipeline && pipeline.length > 0 && (
        <div className="rounded-lg border border-accent/20 bg-surface-2/60 backdrop-blur-sm p-4 glow-accent-sm">
          <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
            Current Pipeline
          </h3>
          <div className="flex items-center gap-2 overflow-x-auto">
            {pipeline.map((step, i) => (
              <div key={step.label} className="flex items-center gap-2">
                <div className="rounded-md border border-border bg-surface-1 px-3 py-2 min-w-[120px]">
                  <p className="text-xs text-text-muted">{step.label}</p>
                  <p className="text-sm font-medium text-text-primary">
                    {step.value ?? "—"}
                  </p>
                  {step.confidence != null && (
                    <p className="text-xs text-text-muted">
                      {(step.confidence * 100).toFixed(0)}% conf
                    </p>
                  )}
                </div>
                {i < pipeline.length - 1 && (
                  <span className="text-text-muted">→</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="flex gap-2">
        {(Object.keys(FILTER_LABELS) as AgentFilter[]).map((key) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              filter === key
                ? "bg-accent/10 text-accent"
                : "bg-surface-2 text-text-secondary hover:text-text-primary"
            }`}
          >
            {FILTER_LABELS[key]}
          </button>
        ))}
      </div>

      {/* Traces List */}
      <div className="space-y-2">
        {filteredTraces.length === 0 ? (
          <div className="flex items-center justify-center rounded-lg border border-border bg-surface-1 p-12">
            <p className="text-text-muted text-sm">No agent traces yet</p>
          </div>
        ) : (
          filteredTraces.map((trace) => (
            <TraceRow
              key={trace.traceId}
              trace={trace}
              expanded={expandedId === trace.traceId}
              onToggle={() =>
                setExpandedId(
                  expandedId === trace.traceId ? null : trace.traceId
                )
              }
            />
          ))
        )}
      </div>

      {/* Agent Context */}
      {context && (
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">
            Agent Context Snapshot
          </h3>
          <pre className="text-xs text-text-muted font-mono overflow-x-auto max-h-64 overflow-y-auto">
            {JSON.stringify(context, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function TraceRow({
  trace,
  expanded,
  onToggle,
}: {
  trace: AgentTrace;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = AGENT_ICONS[trace.agentType] ?? Bot;
  const color = AGENT_COLORS[trace.agentType] ?? "text-text-primary";
  const output = trace.output as Record<string, unknown>;

  return (
    <div className="rounded-lg border border-border bg-surface-1 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-2 transition-colors text-left"
      >
        <Icon className={`h-4 w-4 ${color}`} />
        <span className={`text-xs font-semibold uppercase ${color}`}>
          {trace.agentType}
        </span>
        <span className="text-xs text-text-muted font-mono">
          {trace.windowId}
        </span>
        <span className="ml-auto flex items-center gap-3 text-xs text-text-muted">
          <span>{trace.model}</span>
          <span>{trace.latencyMs}ms</span>
          <span>{formatTimeAgo(trace.createdAt)}</span>
          <span>{expanded ? "▲" : "▼"}</span>
        </span>
      </button>

      {/* Summary line */}
      {!expanded && output && (
        <div className="px-4 pb-2 flex gap-4 text-xs text-text-secondary">
          {output.regime && <span>Regime: <b className="text-text-primary">{String(output.regime)}</b></span>}
          {output.direction && <span>Direction: <b className="text-text-primary">{String(output.direction)}</b></span>}
          {output.action && <span>Action: <b className="text-text-primary">{String(output.action)}</b></span>}
          {output.confidence != null && <span>Confidence: <b className="text-text-primary">{(Number(output.confidence) * 100).toFixed(0)}%</b></span>}
          {output.magnitude != null && <span>Magnitude: <b className="text-text-primary">{Number(output.magnitude).toFixed(3)}</b></span>}
        </div>
      )}

      {expanded && (
        <div className="border-t border-border px-4 py-3 space-y-3 bg-surface-0">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1">
                Input
              </p>
              <pre className="text-xs text-text-muted font-mono overflow-x-auto max-h-48 overflow-y-auto rounded bg-surface-2 p-2">
                {JSON.stringify(trace.input, null, 2)}
              </pre>
            </div>
            <div>
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1">
                Output
              </p>
              <pre className="text-xs text-text-muted font-mono overflow-x-auto max-h-48 overflow-y-auto rounded bg-surface-2 p-2">
                {JSON.stringify(trace.output, null, 2)}
              </pre>
            </div>
          </div>
          <div className="flex gap-4 text-xs text-text-muted">
            <span>Provider: {trace.provider}</span>
            <span>Model: {trace.model}</span>
            <span>Latency: {trace.latencyMs}ms</span>
            <span>Tokens: {trace.tokenCount}</span>
            <span>Trace: <code className="text-text-secondary">{trace.traceId}</code></span>
          </div>
        </div>
      )}
    </div>
  );
}
