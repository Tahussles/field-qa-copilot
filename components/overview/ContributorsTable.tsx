"use client";

import { Section } from "@/components/ui/Disclosure";
import { useTip } from "@/components/ui/Tip";
import { CHECK_TITLE, mainSignal, rankChecks, STATUS_CLASS, STATUS_LABEL, statusColor } from "@/lib/checks";
import type { ContributorRow } from "@/lib/types";

/** Every contributor, full width under the map, closed until asked for (the ones to look at are in "Needs attention"). */
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
    <Section
      title="All contributors"
      aria-label="All contributors"
      summary={rows.length ? String(rows.length) : null}
      collapsible
      defaultOpen={false}
      storeKey="contributors-all"
      bodyClassName=""
      data-testid="all-contributors"
    >
      <div className="scrollbar-thin max-h-[560px] overflow-auto">
        <table className="table" data-testid="contributors">
          <thead>
            <tr>
              <th>Contributor</th>
              <th>Area</th>
              <th>Flagged</th>
              <th>Main signal</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.contributor_id} row={r} selected={focus === r.code} onFocus={onFocus} />
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Row({ row, selected, onFocus }: { row: ContributorRow; selected: boolean; onFocus: (code: string | null) => void }) {
  const main = mainSignal(row.checks_fired);
  const ranked = rankChecks(row.checks_fired);
  const others = ranked.filter(([key]) => key !== main);
  const pct = Math.round(row.flag_rate * 100);
  const { triggerProps, tip } = useTip(
    ranked.length ? ranked.map(([key, n]) => `${CHECK_TITLE[key]} ${n}`).join(" · ") : "No checks fired",
    { delay: 450 },
  );
  return (
    <tr
      tabIndex={0}
      aria-selected={selected}
      onClick={() => onFocus(selected ? null : row.code)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onFocus(selected ? null : row.code))}
      className={`cursor-pointer outline-none ${selected ? "bg-accent-soft" : "hover:bg-hover"}`}
      {...triggerProps}
    >
      <td className="whitespace-nowrap">
        {row.display_name} <span className="font-mono text-muted">{row.code}</span>
      </td>
      <td className="text-muted">{row.area}</td>
      <td>
        <div className="flex items-center gap-2">
          <span className="w-12 font-mono tabular-nums">
            {row.flagged}/{row.submissions}
          </span>
          <div className="bar max-w-[96px]" aria-label={`${pct}%`}>
            <i style={{ width: `${Math.min(100, pct)}%`, background: statusColor(row.status) }} />
          </div>
        </div>
      </td>
      <td>
        <div className="flex gap-1 whitespace-nowrap">
          {main ? <span className="chip">{CHECK_TITLE[main]}</span> : <span className="text-faint">none</span>}
          {others.length > 0 && <span className="chip">+{others.length}</span>}
        </div>
        {tip}
      </td>
      <td>
        <span className={`st ${STATUS_CLASS[row.status]}`}>
          <span>{STATUS_LABEL[row.status]}</span>
        </span>
      </td>
    </tr>
  );
}
