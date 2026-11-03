"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAppData } from "@/components/app/AppData";
import { useWithPasscode } from "@/components/app/Passcode";
import { useToast } from "@/components/app/Toasts";
import { api } from "@/lib/api";
import { biggestHotspots, CHECK_ACTION, CHECK_LABEL, mainSignal } from "@/lib/checks";
import { fmtDuration, fmtLocalDate, fmtPct, fmtTime } from "@/lib/format";
import type { BriefState, Overview } from "@/lib/types";

const BRIEF_TOP = 4;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The morning brief. A model writes it from the /overview numbers (checked: every
 * number must come from them); until it has, or if it failed, the template below
 * shows the same numbers. Listen reads the written brief aloud.
 */
export function Brief({ overview }: { overview: Overview | null }) {
  const { version } = useAppData();
  const withPasscode = useWithPasscode();
  const toast = useToast();
  const body = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BriefState | null>(null);
  const [showFacts, setShowFacts] = useState(false);
  const [busy, setBusy] = useState<"regenerate" | "audio" | null>(null);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.brief().then(
      (s) => !cancelled && setState(s),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => () => audio.current?.pause(), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(body.current?.innerText ?? "");
      toast({ tone: "ok", title: "Brief copied" });
    } catch {
      toast({ tone: "error", title: "Copy was blocked by the browser" });
    }
  }

  async function regenerate() {
    setBusy("regenerate");
    try {
      const res = await withPasscode((code) => api.regenerateBrief(code));
      if (res) {
        toast({ tone: "info", title: res.queued ? "Writing a new brief" : "The brief is already being written" });
        setState((s) => (s ? { ...s, writing: true } : s));
      }
    } catch (e) {
      toast({ tone: "error", title: "Could not regenerate", body: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(null);
    }
  }

  const listen = useCallback(async () => {
    const brief = state?.brief;
    if (!brief) return;
    if (playing) {
      audio.current?.pause();
      setPlaying(false);
      return;
    }
    setBusy("audio");
    try {
      const { url } = await api.briefAudio(brief.id);
      audio.current?.pause();
      const player = new Audio(url);
      audio.current = player;
      player.onended = () => setPlaying(false);
      await player.play();
      setPlaying(true);
    } catch (e) {
      toast({ tone: "error", title: "Listen is unavailable", body: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(null);
    }
  }, [state?.brief, playing, toast]);

  const written = state?.brief?.status === "ai" ? state.brief : null;
  const fallback = state?.brief?.status === "template" ? state.brief : null;

  return (
    <section aria-labelledby="brief-title" className="panel scroll-mt-4" id="brief">
      <div className="ph">
        <h2 id="brief-title">Morning brief</h2>
        <div className="flex items-center gap-1.5">
          {written && (
            <button type="button" onClick={() => void listen()} disabled={busy === "audio"} className="btn btn-sm" aria-pressed={playing}>
              {busy === "audio" ? <span className="ai-spinner" aria-hidden /> : <IconSpeaker />}
              {playing ? "Pause" : "Listen"}
            </button>
          )}
          <button type="button" onClick={() => void regenerate()} disabled={busy === "regenerate" || state?.writing} className="btn btn-sm">
            Regenerate
          </button>
          <button type="button" onClick={() => void copy()} disabled={!overview} className="btn btn-sm">
            Copy
          </button>
        </div>
      </div>
      <div className="px-4 py-3.5">
        <div ref={body}>
          {written?.items ? (
            <WrittenBrief brief={written.items} overview={overview} />
          ) : !overview ? (
            <p className="text-muted">Preparing the brief…</p>
          ) : (
            <BriefBody overview={overview} />
          )}
        </div>
        <BriefFooter state={state} written={Boolean(written)} fallbackReason={fallback?.fallback?.reason ?? null}
          showFacts={showFacts} onToggleFacts={() => setShowFacts((v) => !v)} />
      </div>
    </section>
  );
}

function WrittenBrief({ brief, overview }: { brief: NonNullable<NonNullable<BriefState["brief"]>["items"]>; overview: Overview | null }) {
  const people = new Map((overview?.contributors ?? []).map((c) => [c.code, c]));
  return (
    <div className="text-ink-2 [&_p]:mb-2.5 [&_p]:max-w-[68ch]">
      <p>{brief.summary}</p>
      {brief.items.length > 0 && (
        <ul className="mt-1 mb-3 flex flex-col gap-2.5">
          {brief.items.map((item) => {
            const who = people.get(item.contributor_code);
            return (
              <li key={item.contributor_code} className="max-w-[72ch] border-l-2 border-crit pl-3">
                <b className="font-semibold text-ink">
                  {item.contributor_code} {who?.display_name}
                </b>{" "}
                {who?.area && <span className="text-muted">{who.area}</span>}
                <br />
                {item.finding}
                <span className="mt-0.5 block text-accent">→ {item.action}</span>
              </li>
            );
          })}
        </ul>
      )}
      {brief.closing && <p className="text-muted">{brief.closing}</p>}
    </div>
  );
}

function BriefFooter({ state, written, fallbackReason, showFacts, onToggleFacts }: {
  state: BriefState | null;
  written: boolean;
  fallbackReason: string | null;
  showFacts: boolean;
  onToggleFacts: () => void;
}) {
  if (!state) return <p className="mt-2.5 text-[12px] text-faint">Template draft from the overview numbers.</p>;
  const facts = state.brief?.stats ?? state.facts;
  return (
    <div className="mt-2.5 text-[12px] text-faint">
      {state.writing && (
        <p className="flex items-center gap-2 text-muted">
          <span className="ai-spinner" aria-hidden /> Claude is writing {written ? "a new" : "the"} brief from today&apos;s numbers…
        </p>
      )}
      {written && state.brief ? (
        <p>
          <button type="button" onClick={onToggleFacts} className="text-muted underline decoration-dotted underline-offset-2 hover:text-ink"
            aria-expanded={showFacts}>
            Written by Claude from these numbers
          </button>{" "}
          · <span className="font-mono">{state.brief.model}</span> · {fmtTime(state.brief.created_at)}
          {state.stale && " · the numbers have changed since; Regenerate to update"}
        </p>
      ) : (
        <p>
          Template from the overview numbers
          {fallbackReason ? ` · the model's brief was not used (${fallbackReason})` : state.writing ? "" : "."}
        </p>
      )}
      {showFacts && (
        <pre className="scrollbar-thin mt-2 max-h-64 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-[11px] text-muted">
          {JSON.stringify(facts, null, 2)}
        </pre>
      )}
    </div>
  );
}

function IconSpeaker() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.6}>
      <path d="M3 6h2.5L9 3v10L5.5 10H3z" />
      <path d="M11.5 5.5a3.5 3.5 0 0 1 0 5M13 3.5a6 6 0 0 1 0 9" />
    </svg>
  );
}

function BriefBody({ overview }: { overview: Overview }) {
  const y = overview.yesterday;
  const t = overview.today;
  const investigate = overview.contributors.filter((c) => c.status === "investigate");
  const watch = overview.contributors.filter((c) => c.status === "watch");
  const hotspotFor = biggestHotspots(overview.hotspots);
  const worstArea = [...overview.areas].sort((a, b) => b.flag_rate - a.flag_rate)[0];

  return (
    <div className="text-ink-2 [&_p]:mb-2.5 [&_p]:max-w-[68ch]">
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
