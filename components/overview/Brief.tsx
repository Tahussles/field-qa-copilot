"use client";

import { useRef } from "react";

import { useToast } from "@/components/app/Toasts";
import { biggestHotspots, CHECK_ACTION, CHECK_LABEL, mainSignal } from "@/lib/checks";
import { fmtDuration, fmtLocalDate, fmtPct } from "@/lib/format";
import type { Overview } from "@/lib/types";

const BRIEF_TOP = 4;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Template brief from /overview. Claude writes the real one in round 7. */
export function Brief({ overview }: { overview: Overview | null }) {
  const toast = useToast();
  const body = useRef<HTMLDivElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(body.current?.innerText ?? "");
      toast({ tone: "ok", title: "Brief copied" });
    } catch {
      toast({ tone: "error", title: "Copy was blocked by the browser" });
    }
  }

  return (
    <section aria-labelledby="brief-title" className="panel">
      <div className="ph">
        <h2 id="brief-title">Morning brief</h2>
        <button type="button" onClick={() => void copy()} disabled={!overview} className="btn btn-sm">
          Copy
        </button>
      </div>
      <div className="px-4 py-3.5">
        {!overview ? <p className="text-muted">Preparing the brief…</p> : <BriefBody ref={body} overview={overview} />}
        <p className="mt-2.5 text-[12px] text-faint">
          Template draft. In round 7 Claude writes this from the same numbers.
        </p>
      </div>
    </section>
  );
}

function BriefBody({ overview, ref }: { overview: Overview; ref: React.Ref<HTMLDivElement> }) {
  const y = overview.yesterday;
  const t = overview.today;
  const investigate = overview.contributors.filter((c) => c.status === "investigate");
  const watch = overview.contributors.filter((c) => c.status === "watch");
  const hotspotFor = biggestHotspots(overview.hotspots);
  const worstArea = [...overview.areas].sort((a, b) => b.flag_rate - a.flag_rate)[0];

  return (
    <div ref={ref} className="text-ink-2 [&_p]:mb-2.5 [&_p]:max-w-[68ch]">
      <p>
        Yesterday, {fmtLocalDate(y.date)}, brought <b className="font-semibold text-ink">{y.received}</b> submissions,{" "}
        <b className="font-semibold text-ink">{y.flagged}</b> flagged ({fmtPct(y.received ? y.flagged / y.received : 0, 1)}).
        {y.median_duration_sec != null && ` Median interview ${fmtDuration(y.median_duration_sec)}.`} So far today: {t.received}{" "}
        received, {t.flagged} flagged.{" "}
        {investigate.length ? (
          <b className="font-semibold text-ink">
            {investigate.length === 1 ? "One contributor needs" : `${investigate.length} contributors need`} attention today.
          </b>
        ) : (
          "No contributor crosses the investigate line."
        )}
      </p>
      {investigate.length > 0 && (
        <ul className="mt-1 mb-3 flex flex-col gap-2.5">
          {investigate.slice(0, BRIEF_TOP).map((c) => {
            const signal = mainSignal(c.checks_fired);
            const hotspot = hotspotFor.get(c.code);
            return (
              <li key={c.contributor_id} className="max-w-[72ch] border-l-2 border-crit pl-3">
                <b className="font-semibold text-ink">
                  {c.code} {c.display_name}
                </b>{" "}
                <span className="text-muted">{c.area}</span>
                <br />
                {c.flagged} of {c.submissions} flagged ({fmtPct(c.flag_rate)})
                {signal && (
                  <>
                    , mostly {CHECK_LABEL[signal]}
                    {signal === "same_spot" && hotspot
                      ? `: ${hotspot.count} interviews in one spot${hotspot.mostly_off_hours ? ", mostly after 22:00" : ""}`
                      : ""}
                  </>
                )}
                .{signal && <span className="mt-0.5 block text-accent">→ {cap(CHECK_ACTION[signal])}.</span>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-muted">
        {investigate.length > BRIEF_TOP && `${investigate.length - BRIEF_TOP} more in the contributors table. `}
        {worstArea && `Highest flag rate: ${worstArea.area} (${fmtPct(worstArea.flag_rate)}). `}
        Queue: {overview.kpis.pending_review} waiting.
        {watch.length > 0 && ` Watch: ${watch.map((c) => c.code).join(", ")}.`}
      </p>
    </div>
  );
}
