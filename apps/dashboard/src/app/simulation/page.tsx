import { PageHeader } from "@/components/layout/page-header";

export default function SimulationPage() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader title="Simulation" subtitle="Paper trading performance and decision quality" />
      <div className="flex items-center justify-center rounded-lg border border-border bg-surface-1 p-16">
        <p className="text-text-muted text-sm">Coming in Phase 2</p>
      </div>
    </div>
  );
}
