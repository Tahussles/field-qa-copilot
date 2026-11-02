import { CHECK_TITLE, mainSignal, rankChecks, STATUS_CLASS, STATUS_LABEL, statusColor } from "@/lib/checks";
import type { ContributorRow } from "@/lib/types";

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
      <div className="ph">
        <h2 id="contributors-title">Contributors</h2>
        <span className="ph-caption">Click a row to zoom the map to them</span>
      </div>
      <div className="scrollbar-thin max-h-[420px] overflow-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Contributor</th>
              <th>Area</th>
              <th className="font-mono">Subs</th>
              <th>Flagged</th>
              <th>Main signals</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const selected = focus === row.code;
              const main = mainSignal(row.checks_fired);
              const signals = rankChecks(row.checks_fired).slice(0, 3);
              const pct = Math.round(row.flag_rate * 100);
              return (
                <tr
                  key={row.contributor_id}
                  tabIndex={0}
                  aria-selected={selected}
                  onClick={() => onFocus(selected ? null : row.code)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onFocus(selected ? null : row.code))}
                  className={`cursor-pointer outline-none ${selected ? "bg-accent-soft" : "hover:bg-hover"}`}
                >
                  <td className="whitespace-nowrap">
                    <span className="font-mono text-muted">{row.code}</span> {row.display_name}
                  </td>
                  <td className="text-muted">{row.area}</td>
                  <td className="font-mono text-muted tabular-nums">{row.submissions}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="w-8 font-mono tabular-nums">{pct}%</span>
                      <div className="bar" aria-hidden>
                        <i style={{ width: `${Math.min(100, pct)}%`, background: statusColor(row.status) }} />
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {signals.length ? (
                        signals.map(([key, n]) => (
                          <span key={key} className="chip" title={key === main ? "Main signal" : undefined}>
                            {CHECK_TITLE[key]} <b>{n}</b>
                          </span>
                        ))
                      ) : (
                        <span className="text-faint">none</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <span className={`st ${STATUS_CLASS[row.status]}`}>
                      <span>{STATUS_LABEL[row.status]}</span>
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
