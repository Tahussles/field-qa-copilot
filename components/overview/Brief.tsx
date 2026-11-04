"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAppData } from "@/components/app/AppData";
import { useWithPasscode } from "@/components/app/Passcode";
import { useToast } from "@/components/app/Toasts";
import { Chevron, Reveal, Section, useStoredOpen } from "@/components/ui/Disclosure";
import { MethodChip } from "@/components/ui/Tip";
import { api } from "@/lib/api";
import { biggestHotspots, CHECK_ACTION, CHECK_LABEL, mainSignal } from "@/lib/checks";
import { fmtDuration, fmtLocalDate, fmtPct, fmtTime } from "@/lib/format";
import type { BriefState, Overview } from "@/lib/types";

// Summary first: the headline sentence and the top three contributors; "Show full brief" for the rest.
const BRIEF_TOP = 3;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The first sentence, and the rest ("11.3 percent" does not end one). */
function splitHeadline(text: string): [string, string] {
  const m = text.match(/^(.+?[.!?])\s+(?=[A-Z0-9])/);
  return m ? [m[1], text.slice(m[0].length)] : [text, ""];
}

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
  const [full, setFull] = useStoredOpen("brief-full", false);
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

  const method = written ? (
    <MethodChip
      ai
      tip={`Written by ${written.model} at ${fmtTime(written.created_at)} from today's numbers; every number in it is checked against them.`}
    />
  ) : state ? (
    <MethodChip ai={false} tip={`A template from the overview numbers${fallback?.fallback?.reason ? `; the model's brief was not used (${fallback.fallback.reason})` : ""}.`} />
  ) : null;

  return (
    <Section
      id="brief"
      className="scroll-mt-4"
      title="Morning brief"
      aria-label="Morning brief"
      actions={
        <>
          {method}
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
        </>
      }
    >
      <div ref={body}>
        {written?.items ? (
          <WrittenBrief brief={written.items} overview={overview} full={full} />
        ) : !overview ? (
          <p className="text-muted">Preparing the brief…</p>
        ) : (
          <BriefBody overview={overview} full={full} />
        )}
      </div>
      {(written?.items || overview) && (
        <button
          type="button"
          className="disclosure mt-1 text-[12.5px] text-accent-ink"
          aria-expanded={full}
          aria-controls="brief-rest"
          onClick={() => setFull(!full)}
          data-testid="brief-toggle"
        >
          <Chevron />
          {full ? "Show less" : "Show full brief"}
        </button>
      )}
      <BriefFooter state={state} written={Boolean(written)} showFacts={showFacts} onToggleFacts={() => setShowFacts((v) => !v)} />
    </Section>
  );
}

function WrittenBrief({ brief, overview, full }: {
  brief: NonNullable<NonNullable<BriefState["brief"]>["items"]>;
  overview: Overview | null;
  full: boolean;
}) {
  const people = new Map((overview?.contributors ?? []).map((c) => [c.code, c]));
  const [headline, rest] = splitHeadline(brief.summary);
  const item = (it: (typeof brief.items)[number]) => {
    const who = people.get(it.contributor_code);
    return (
      <li key={it.contributor_code} className="max-w-[72ch] border-l-2 border-crit pl-3">
        <b className="font-semibold text-ink">
          {it.contributor_code} {who?.display_name}
        </b>{" "}
        {who?.area && <span className="text-muted">{who.area}</span>}
        <br />
        {it.finding}
        <span className="mt-0.5 block text-accent-ink">→ {it.action}</span>
      </li>
    );
  };
  return (
    <div className="text-ink-2 [&_p]:mb-2.5 [&_p]:max-w-[68ch]">
      <p className="text-ink" data-testid="brief-headline">{headline}</p>
      {brief.items.length > 0 && <ul className="mt-1 mb-2 flex flex-col gap-2.5">{brief.items.slice(0, BRIEF_TOP).map(item)}</ul>}
      <Reveal open={full} id="brief-rest">
        {rest && <p>{rest}</p>}
        {brief.items.length > BRIEF_TOP && <ul className="mb-3 flex flex-col gap-2.5">{brief.items.slice(BRIEF_TOP).map(item)}</ul>}
        {brief.closing && <p className="text-muted">{brief.closing}</p>}
      </Reveal>
    </div>
  );
}

function BriefFooter({ state, written, showFacts, onToggleFacts }: {
  state: BriefState | null;
  written: boolean;
  showFacts: boolean;
  onToggleFacts: () => void;
}) {
  if (!state) return null;
  const facts = state.brief?.stats ?? state.facts;
  return (
    <div className="mt-2 text-[12px] text-faint">
      {state.writing && (
        <p className="flex items-center gap-2 text-muted">
          <span className="ai-spinner" aria-hidden /> Claude is writing {written ? "a new" : "the"} brief from today&apos;s numbers…
        </p>
      )}
      {written && state.stale && <p className="text-muted">The numbers have changed since; Regenerate to update.</p>}
      <button type="button" onClick={onToggleFacts} className="mt-1 text-muted underline decoration-dotted underline-offset-2 hover:text-ink"
        aria-expanded={showFacts}>
        {showFacts ? "Hide" : "Show"} the numbers it is {written ? "written" : "built"} from
      </button>
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

function BriefBody({ overview, full }: { overview: Overview; full: boolean }) {
  const y = overview.yesterday;
  const t = overview.today;
  const investigate = overview.contributors.filter((c) => c.status === "investigate");
  const watch = overview.contributors.filter((c) => c.status === "watch");
  const hotspotFor = biggestHotspots(overview.hotspots);
  const worstArea = [...overview.areas].sort((a, b) => b.flag_rate - a.flag_rate)[0];
  const item = (c: (typeof investigate)[number]) => {
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
        .{signal && <span className="mt-0.5 block text-accent-ink">→ {cap(CHECK_ACTION[signal])}.</span>}
      </li>
    );
  };

  return (
    <div className="text-ink-2 [&_p]:mb-2.5 [&_p]:max-w-[68ch]">
      <p className="text-ink" data-testid="brief-headline">
        Yesterday, {fmtLocalDate(y.date)}, brought <b className="font-semibold">{y.received}</b> submissions,{" "}
        <b className="font-semibold">{y.flagged}</b> flagged ({fmtPct(y.received ? y.flagged / y.received : 0, 1)});{" "}
        {investigate.length
          ? `${investigate.length === 1 ? "one contributor needs" : `${investigate.length} contributors need`} attention today.`
          : "no contributor crosses the investigate line."}
      </p>
      {investigate.length > 0 && <ul className="mt-1 mb-2 flex flex-col gap-2.5">{investigate.slice(0, BRIEF_TOP).map(item)}</ul>}
      <Reveal open={full} id="brief-rest">
        <p>
          {y.median_duration_sec != null && `Median interview ${fmtDuration(y.median_duration_sec)}. `}So far today: {t.received} received,{" "}
          {t.flagged} flagged.
        </p>
        {investigate.length > BRIEF_TOP && <ul className="mb-3 flex flex-col gap-2.5">{investigate.slice(BRIEF_TOP).map(item)}</ul>}
        <p className="text-muted">
          {worstArea && `Highest flag rate: ${worstArea.area} (${fmtPct(worstArea.flag_rate)}). `}
          Queue: {overview.kpis.pending_review} waiting.
          {watch.length > 0 && ` Watch: ${watch.map((c) => c.code).join(", ")}.`}
        </p>
      </Reveal>
    </div>
  );
}
