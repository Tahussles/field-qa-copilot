"use client";

import { useAppData } from "@/components/app/AppData";

/** The KPI strip on Overview: one hairline-divided band, mono values, label underneath. */
export function Kpis() {
  const { overview } = useAppData();
  const k = overview?.kpis;
  const flaggedPct = k && k.received ? `${Math.round((100 * k.flagged) / k.received)}%` : null;
  const items = [
    { id: "received", value: k?.received, small: overview ? `${overview.today.received} today` : null, label: "Submissions received" },
    { id: "flagged", value: k?.flagged, small: flaggedPct, label: "Flagged by checks" },
    { id: "watch", value: k?.watch, small: null, label: "Watch band, counted only" },
    { id: "waiting", value: k?.pending_review, small: null, label: "Waiting for review" },
    { id: "investigate", value: k?.contributors_to_investigate, small: null, label: "Contributors to investigate" },
  ];
  return (
    <section
      aria-label="Key numbers"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line-strong bg-line-strong lg:grid-cols-5 [&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-1"
    >
      {items.map((item) => (
        <div key={item.id} className="bg-bg px-4 py-3.5">
          <div className="font-mono text-[22px] font-medium tabular-nums">
            <span key={item.value ?? "loading"} data-testid={`kpi-${item.id}`} className="flash">
              {item.value ?? "—"}
            </span>
            {item.small && <small className="ml-2 text-[12px] font-normal text-muted">{item.small}</small>}
          </div>
          <div className="text-[12px] text-muted">{item.label}</div>
        </div>
      ))}
    </section>
  );
}
