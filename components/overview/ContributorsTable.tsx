import { CHECK_LABEL, mainSignal, rankChecks, statusColor } from "@/lib/checks";
import { fmtPct } from "@/lib/format";
import type { ContributorRow } from "@/lib/types";

const STATUS_LABEL = { investigate: "Investigate", watch: "Watch", ok: "OK" } as const;

export function ContributorsTable({
  rows,
  focus,
  onFocus,
}: {
  rows: ContributorRow[];
  focus: string | null;
  onFocus: (code: string | null) => void;
}) {
  return (
    <section aria-labelledby="contributors-title" className="panel overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 id="contributors-title" className="font-display text-sm font-semibold">
          Contributors
        </h2>
        <span className="text-[12px] text-faint">{rows.length}</span>
        <span className="ml-auto text-[12px] text-faint">Click a row to show only them on the map</span>
      </div>
      <div className="scrollbar-thin max-h-[440px] overflow-auto">
        <table className="w-full min-w-[820px] text-left text-[13px] whitespace-nowrap">
          <thead className="sticky top-0 bg-panel text-[11.5px] text-faint">
            <tr>
              <th className="py-2 pr-2 pl-4 font-normal">Code</th>
              <th className="px-2 font-normal">Name</th>
              <th className="px-2 font-normal">Kind</th>
              <th className="px-2 font-normal">Area</th>
              <th className="px-2 text-right font-normal">Subs</th>
              <th className="px-2 font-normal">Flagged</th>
              <th className="px-2 font-normal">Main signals</th>
              <th className="py-2 pr-4 pl-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const selected = focus === row.code;
              const color = statusColor(row.status);
              const main = mainSignal(row.checks_fired);
              const signals = rankChecks(row.checks_fired).slice(0, 2);
              return (
                <tr
                  key={row.contributor_id}
                  tabIndex={0}
                  aria-selected={selected}
                  onClick={() => onFocus(selected ? null : row.code)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onFocus(selected ? null : row.code))}
                  className={`cursor-pointer border-t border-line outline-none transition-colors focus-visible:bg-white/[0.04] ${
                    selected ? "bg-accent/[0.09]" : "hover:bg-white/[0.025]"
                  } ${focus && !selected ? "opacity-55" : ""}`}
                >
                  <td className="py-2 pr-2 pl-4 font-mono text-[12.5px] text-ink">{row.code}</td>
                  <td className="px-2 text-ink-2">{row.display_name}</td>
                  <td className="px-2 text-muted capitalize">{row.kind}</td>
                  <td className="px-2 text-muted">{row.area}</td>
                  <td className="px-2 text-right tabular-nums text-ink-2">{row.submissions}</td>
                  <td className="px-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden>
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${Math.max(row.flag_rate * 100, row.flagged ? 3 : 0)}%`, background: color }}
                        />
                      </div>
                      <span className="w-10 tabular-nums text-[12px] text-muted">{fmtPct(row.flag_rate)}</span>
                    </div>
                  </td>
                  <td className="px-2">
                    <div className="flex gap-1">
                      {signals.map(([key, n]) => (
                        <span
                          key={key}
                          title={key === main ? "Main signal" : undefined}
                          className={`rounded-md px-1.5 py-0.5 text-[11px] whitespace-nowrap ${
                            key === main ? "bg-white/[0.08] text-ink-2" : "bg-white/[0.04] text-muted"
                          }`}
                        >
                          {CHECK_LABEL[key]} <span className="text-faint">{n}</span>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-2 pr-4 pl-2">
                    <span className="flex items-center gap-1.5 text-[12px] text-muted">
                      <span className="dot" style={{ background: color }} aria-hidden />
                      {STATUS_LABEL[row.status]}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
