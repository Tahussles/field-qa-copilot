import { biggestHotspots, CHECK_ACTION, CHECK_LABEL, mainSignal } from "@/lib/checks";
import { fmtDuration, fmtLocalDate, fmtPct } from "@/lib/format";
import type { Overview } from "@/lib/types";

const BRIEF_TOP = 4;

/** Template brief from /overview. Claude writes the real one in round 7. */
export function Brief({ overview }: { overview: Overview | null }) {
  if (!overview) {
    return <section className="panel min-h-48 p-4 text-sm text-muted">Preparing the brief…</section>;
  }
  const y = overview.yesterday;
  const t = overview.today;
  const investigate = overview.contributors.filter((c) => c.status === "investigate");
  const watch = overview.contributors.filter((c) => c.status === "watch");
  const hotspotFor = biggestHotspots(overview.hotspots);

  return (
    <section aria-labelledby="brief-title" className="panel scrollbar-thin flex flex-col p-4 xl:h-[600px] xl:overflow-y-auto">
      <div className="flex items-center gap-2">
        <h2 id="brief-title" className="font-display text-sm font-semibold">
          Morning brief
        </h2>
        <span className="text-[12px] text-faint">{fmtLocalDate(t.date)}</span>
        <span
          className="ml-auto rounded-md border border-line-strong px-1.5 py-0.5 text-[10.5px] text-muted"
          title="Built from a fixed template. Claude writes this brief in round 7."
        >
          Template
        </span>
      </div>

      <div className="mt-3 space-y-3 text-[13.5px] leading-relaxed text-ink-2">
        <p>
          <span className="text-ink">Yesterday, {fmtLocalDate(y.date)}:</span> {y.received} submissions came in and{" "}
          <span className="text-warn">{y.flagged} were flagged</span> (
          {fmtPct(y.received ? y.flagged / y.received : 0, 1)}).{" "}
          {y.pending_review > 0 ? `${y.pending_review} of those still wait for review.` : "All of them have a decision."}
          {y.median_duration_sec != null && ` Median interview: ${fmtDuration(y.median_duration_sec)}.`}
        </p>
        {t.received > 0 && (
          <p>
            <span className="text-ink">So far today:</span> {t.received} received, {t.flagged} flagged.
          </p>
        )}

        {investigate.length ? (
          <div>
            <p className="text-ink">Investigate {investigate.length === 1 ? "one contributor" : `${investigate.length} contributors`}:</p>
            <ul className="mt-1.5 space-y-2">
              {investigate.slice(0, BRIEF_TOP).map((c) => {
                const signal = mainSignal(c.checks_fired);
                const hotspot = hotspotFor.get(c.code);
                return (
                  <li key={c.contributor_id} className="flex gap-2">
                    <span className="dot mt-[7px] bg-crit" aria-hidden />
                    <span>
                      <span className="font-mono text-ink">{c.code}</span>{" "}
                      <span className="text-ink">{c.display_name}</span>
                      <span className="text-muted"> ({c.area})</span> — {c.flagged} of {c.submissions} flagged (
                      {fmtPct(c.flag_rate)})
                      {signal && (
                        <>
                          , mostly <span className="text-ink">{CHECK_LABEL[signal]}</span>
                          {signal === "same_spot" && hotspot
                            ? `: ${hotspot.count} interviews in one spot${hotspot.mostly_off_hours ? ", mostly after 22:00" : ""}`
                            : ""}
                        </>
                      )}
                      . {signal && <span className="text-muted">Recommended: {CHECK_ACTION[signal]}.</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
            {investigate.length > BRIEF_TOP && (
              <p className="mt-2 text-muted">
                {investigate.length - BRIEF_TOP} more in the contributors table below.
              </p>
            )}
          </div>
        ) : (
          <p>No contributor crosses the investigate line (3+ flagged and at least 15% of their submissions).</p>
        )}

        {watch.length > 0 && (
          <p className="text-muted">
            Keep an eye on {watch.map((c) => c.code).join(", ")}: a few flags each, not enough to act on yet.
          </p>
        )}
      </div>
    </section>
  );
}
