"use client";

import { Activity, Heart, HeartCrack, Radio, Wifi } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { HealthTile } from "@/components/cards/health-tile";
import { KpiCard } from "@/components/cards/kpi-card";

import { useServiceHealth, useFeedStatus, useEvents } from "@/lib/hooks";
import { formatTimeAgo } from "@/lib/formatters";

export default function HealthPage() {
  const health = useServiceHealth();
  const feeds = useFeedStatus();
  const events = useEvents();

  const services = health.data;
  const feedList = feeds.data;
  const eventList = events.data;

  const alerts = eventList?.filter(
    (e) => e.severity === "warn" || e.severity === "error",
  );

  const healthyCount =
    services?.filter((s) => s.status === "healthy").length ?? 0;
  const degradedCount =
    services?.filter((s) => s.status === "degraded").length ?? 0;
  const unhealthyCount =
    services?.filter((s) => s.status === "unhealthy").length ?? 0;
  const feedsConnected =
    feedList?.filter((f) => f.connected).length ?? 0;

  const isLoading = !services && !feedList && !eventList;

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader
        title="Services & Health"
        subtitle="System status, data feeds, and alerts"
      />

      {/* ── Summary KPI Strip ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard
          label="Healthy"
          value={healthyCount}
          icon={Heart}
          variant="positive"
          subtitle={`of ${services?.length ?? 0} services`}
        />
        <KpiCard
          label="Degraded"
          value={degradedCount}
          icon={Activity}
          variant={degradedCount > 0 ? "warning" : "default"}
        />
        <KpiCard
          label="Unhealthy"
          value={unhealthyCount}
          icon={HeartCrack}
          variant={unhealthyCount > 0 ? "negative" : "default"}
        />
        <KpiCard
          label="Feeds Connected"
          value={feedsConnected}
          icon={Wifi}
          subtitle={`of ${feedList?.length ?? 0} feeds`}
        />
      </div>

      {/* ── Service Status Grid ────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-surface-1 p-4">
        <h2 className="mb-3 text-sm font-semibold text-text-secondary uppercase tracking-wider">
          Service Status
        </h2>
        {services ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {services.map((svc) => (
              <HealthTile
                key={svc.name}
                name={svc.name}
                status={svc.status}
                lastHeartbeat={svc.lastHeartbeat}
                latencyMs={svc.latencyMs}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-muted">Loading...</p>
        )}
      </div>

      {/* ── Feed Status + Alerts ───────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Feed Status */}
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-secondary uppercase tracking-wider">
            Feed Status
          </h2>
          {feedList ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {feedList.map((feed) => (
                <div
                  key={feed.name}
                  className="rounded-lg border border-border bg-surface-2 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        feed.connected ? "bg-positive" : "bg-negative"
                      }`}
                    />
                    <span className="text-sm font-medium text-text-primary">
                      {feed.name}
                    </span>
                    <span
                      className={`ml-auto text-xs ${
                        feed.connected ? "text-positive" : "text-negative"
                      }`}
                    >
                      {feed.connected ? "Connected" : "Disconnected"}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-muted">
                    <span>Last msg: {feed.lastMessageAge ?? '—'}s ago</span>
                    <span>Rate: {feed.messageRate != null ? `${Number(feed.messageRate).toFixed(1)}/s` : '—'}</span>
                    <span>Reconnects: {feed.reconnectCount ?? 0}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-muted">Loading...</p>
          )}
        </div>

        {/* Alerts Panel */}
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-secondary uppercase tracking-wider">
            Alerts
          </h2>
          {alerts ? (
            alerts.length > 0 ? (
              <div className="max-h-80 overflow-y-auto">
                <div className="flex flex-col gap-1">
                  {alerts.map((alert) => (
                    <div
                      key={alert.id}
                      className="flex items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface-2"
                    >
                      <span
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                          alert.severity === "error"
                            ? "bg-negative"
                            : "bg-warning"
                        }`}
                      />
                      <span className="shrink-0 text-xs text-text-muted">
                        {formatTimeAgo(alert.time)}
                      </span>
                      <span className="shrink-0 text-xs font-medium text-text-secondary">
                        {alert.source}
                      </span>
                      <span className="text-xs text-text-primary">
                        {alert.message}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-text-muted">No active alerts</p>
            )
          ) : (
            <p className="text-sm text-text-muted">Loading...</p>
          )}
        </div>
      </div>
    </div>
  );
}
