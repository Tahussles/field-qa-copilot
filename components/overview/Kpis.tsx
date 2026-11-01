import { fmtPct } from "@/lib/format";
import type { Overview } from "@/lib/types";

export function Kpis({ overview }: { overview: Overview | null }) {
  const k = overview?.kpis;
  const items = [
    { id: "received", label: "Received", value: k?.received, note: overview ? `${overview.today.received} today` : "" },
    {
      id: "flagged",
      label: "Flagged",
      value: k?.flagged,
      note: k ? `${fmtPct(k.received ? k.flagged / k.received : 0, 1)} of received` : "",
      tone: "text-warn",
    },
    { id: "watch", label: "Watch", value: k?.watch, note: "below review, counted only" },
    { id: "waiting", label: "Waiting for review", value: k?.pending_review, note: "flagged, no decision yet", tone: "text-accent" },
    {
      id: "investigate",
      label: "Contributors to investigate",
      value: k?.contributors_to_investigate,
      note: "3+ flagged and ≥15% of theirs",
      tone: "text-crit",
    },
  ];
  return (
    <section aria-label="Key numbers" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((item) => (
        <div key={item.label} className="panel px-4 py-3">
          <p className="text-[12px] text-muted">{item.label}</p>
          <p
            key={item.value ?? "loading"}
            data-testid={`kpi-${item.id}`}
            className={`flash mt-1 font-display text-2xl font-semibold tabular-nums ${item.tone ?? "text-ink"}`}
          >
            {item.value ?? "—"}
          </p>
          <p className="mt-0.5 truncate text-[11.5px] text-faint">{item.note}</p>
        </div>
      ))}
    </section>
  );
}
