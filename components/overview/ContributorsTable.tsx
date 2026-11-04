"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { Chevron, Section, useStoredOpen } from "@/components/ui/Disclosure";
import { useTip } from "@/components/ui/Tip";
import { CHECK_TITLE, mainSignal, rankChecks, STATUS_CLASS, STATUS_LABEL, statusColor } from "@/lib/checks";
import type { ContributorRow } from "@/lib/types";

const MAX_OPEN_PX = 560; // opened, the table scrolls past this

/**
 * Contributors to investigate or watch first; "Show all" opens the rest. One table, so the columns line
 * up: closed, its height stops after the last row to look at (animated), and the rest are inert.
 */
export function ContributorsTable({
  rows,
  focus,
  onFocus,
}: {
  rows: ContributorRow[];
  focus: string | null;
  onFocus: (code: string | null) => void;
}) {
  const [all, setAll] = useStoredOpen("contributors-all", false);
  const first = rows.filter((r) => r.status !== "ok");
  const rest = rows.filter((r) => r.status === "ok");
  const table = useRef<HTMLTableElement>(null);
  const [height, setHeight] = useState<{ closed: number; full: number } | null>(null);

  useLayoutEffect(() => {
    const el = table.current;
    if (!el) return;
    const measure = () => {
      const last = [...el.querySelectorAll<HTMLElement>("tbody tr[data-first]")].at(-1) ?? el.querySelector<HTMLElement>("thead tr");
      const closed = last ? last.offsetTop + last.offsetHeight : el.offsetHeight;
      setHeight({ closed, full: el.offsetHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [rows]);

  const row = (r: ContributorRow, isFirst: boolean) => (
    <Row key={r.contributor_id} row={r} first={isFirst} hidden={!isFirst && !all} selected={focus === r.code} onFocus={onFocus} />
  );
  return (
    <Section
      title="Contributors"
      aria-label="Contributors"
      summary={`${first.length} to look at · click a row to zoom the map`}
      bodyClassName=""
      className="overflow-hidden"
    >
      <div
        id="contributors-rest"
        className="scrollbar-thin overflow-x-hidden transition-[height] duration-200 ease-out"
        style={height ? { height: all ? Math.min(height.full, MAX_OPEN_PX) : height.closed, overflowY: all ? "auto" : "hidden" } : undefined}
        data-open={all}
      >
        <table ref={table} className="table [&_td]:px-2.5 [&_th]:px-2.5 [&_td:first-child]:pl-4 [&_th:first-child]:pl-4" data-testid="contributors">
          <thead>
            <tr>
              <th>Contributor</th>
              <th>Flagged</th>
              <th>Main signal</th>
            </tr>
          </thead>
          <tbody>
            {first.map((r) => row(r, true))}
            {rest.map((r) => row(r, false))}
          </tbody>
        </table>
      </div>
      {rest.length > 0 && (
        <div className="border-t border-line px-4 py-2.5">
          <button
            type="button"
            className="disclosure text-[12.5px] text-accent-ink"
            aria-expanded={all}
            aria-controls="contributors-rest"
            onClick={() => setAll(!all)}
            data-testid="contributors-toggle"
          >
            <Chevron />
            {all ? `Show only the ${first.length} to look at` : `Show all ${rows.length}`}
          </button>
        </div>
      )}
    </Section>
  );
}

function Row({ row, first, hidden, selected, onFocus }: {
  row: ContributorRow;
  first: boolean;
  hidden: boolean;
  selected: boolean;
  onFocus: (code: string | null) => void;
}) {
  const main = mainSignal(row.checks_fired);
  const ranked = rankChecks(row.checks_fired);
  const others = ranked.filter(([key]) => key !== main);
  const pct = Math.round(row.flag_rate * 100);
  const { triggerProps, tip } = useTip(
    ranked.length ? (
      <>
        <b className="font-medium text-ink">Checks that fired:</b> {ranked.map(([key, n]) => `${CHECK_TITLE[key]} ${n}`).join(" · ")}
      </>
    ) : (
      "No checks fired"
    ),
    { delay: 450 },
  );
  return (
    <tr
      tabIndex={0}
      data-first={first || undefined}
      inert={hidden}
      aria-selected={selected}
      onClick={() => onFocus(selected ? null : row.code)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onFocus(selected ? null : row.code))}
      className={`cursor-pointer outline-none ${selected ? "bg-accent-soft" : "hover:bg-hover"}`}
      {...triggerProps}
    >
      <td className="whitespace-nowrap">
        <span className="font-mono text-muted">{row.code}</span> {row.display_name}
        <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted">
          <span className={`st ${STATUS_CLASS[row.status]} text-[11.5px]`}>
            <span>{STATUS_LABEL[row.status]}</span>
          </span>
          · {row.area}
        </span>
      </td>
      <td>
        <span className="flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="font-mono tabular-nums">{pct}%</span>
          <span className="font-mono text-[11px] text-muted tabular-nums">
            {row.flagged} of {row.submissions}
          </span>
        </span>
        <div className="bar mt-1 w-[72px] flex-none" aria-hidden>
          <i style={{ width: `${Math.min(100, pct)}%`, background: statusColor(row.status) }} />
        </div>
      </td>
      <td>
        <div className="flex gap-1 whitespace-nowrap">
          {main ? (
            <span className="chip">
              {CHECK_TITLE[main]} <b>{row.checks_fired[main]}</b>
            </span>
          ) : (
            <span className="text-faint">none</span>
          )}
          {others.length > 0 && <span className="chip">+{others.length}</span>}
        </div>
        {tip}
      </td>
    </tr>
  );
}
