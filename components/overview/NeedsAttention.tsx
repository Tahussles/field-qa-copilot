"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAppData } from "@/components/app/AppData";
import { useWithPasscode } from "@/components/app/Passcode";
import { useToast } from "@/components/app/Toasts";
import { Chevron, Reveal, Section, useStoredOpen } from "@/components/ui/Disclosure";
import { Popover, PopoverItem } from "@/components/ui/Popover";
import { MethodChip, useTip } from "@/components/ui/Tip";
import { api } from "@/lib/api";
import { CHECK_ACTION_SHORT, CHECK_LABEL, CHECK_TITLE, mainSignal, rankChecks } from "@/lib/checks";
import { fmtPct, fmtTime } from "@/lib/format";
import type { BriefState, ContributorRow, Overview } from "@/lib/types";

const SHOWN = 6;

type Row = { contributor: ContributorRow; action: string; finding: string };

/**
 * "Needs attention": the brief's one-line headline, then one row per contributor to look at (the brief's
 * order when a model wrote it), each with its flagged count, main check, next step and a Review button.
 * The brief is written from the /overview numbers (every number checked against them) or falls back to
 * a template built from the same numbers.
 */
export function NeedsAttention({ overview, focus, onFocus }: {
  overview: Overview | null;
  focus: string | null;
  onFocus: (code: string | null) => void;
}) {
  const { version } = useAppData();
  const withPasscode = useWithPasscode();
  const toast = useToast();
  const [state, setState] = useState<BriefState | null>(null);
  const [all, setAll] = useStoredOpen("attention-all", false);
  const [source, setSource] = useState(false);
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

  const written = state?.brief?.status === "ai" ? state.brief : null;
  const rows = attentionRows(overview, written?.items ?? null);
  const headline = written?.items?.summary ?? (overview ? templateHeadline(overview) : null);

  async function copy() {
    const text = [headline, ...rows.map((r) => `${r.contributor.code} ${r.contributor.display_name}: ${r.action}`)].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: "ok", title: "Copied" });
    } catch {
      toast({ tone: "error", title: "Copy was blocked by the browser" });
    }
  }

  async function regenerate() {
    setBusy("regenerate");
    try {
      const res = await withPasscode((code) => api.regenerateBrief(code));
      if (res) {
        toast({ tone: "info", title: res.queued ? "Writing a new brief" : "Already writing" });
        setState((s) => (s ? { ...s, writing: true } : s));
      }
    } catch (e) {
      toast({ tone: "error", title: "Could not regenerate", body: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(null);
    }
  }

  const listen = useCallback(async () => {
    if (!written) return;
    if (playing) {
      audio.current?.pause();
      setPlaying(false);
      return;
    }
    setBusy("audio");
    try {
      const { url } = await api.briefAudio(written.id);
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
  }, [written, playing, toast]);

  const method = written ? (
    <MethodChip ai tip={`Written by ${written.model} at ${fmtTime(written.created_at)} from today's numbers; every number is checked against them.`} />
  ) : state ? (
    <MethodChip ai={false} tip={`Built from the overview numbers${state.brief?.fallback?.reason ? `; the model's brief was not used (${state.brief.fallback.reason})` : ""}.`} />
  ) : null;

  return (
    <Section
      id="brief"
      className="min-w-0 scroll-mt-4"
      title="Needs attention"
      aria-label="Needs attention"
      bodyClassName=""
      actions={
        <>
          {state?.writing ? (
            <span className="chip flex items-center gap-1.5" role="status">
              <span className="ai-spinner" aria-hidden /> Writing
            </span>
          ) : (
            written && state?.stale && (
              <button type="button" onClick={() => void regenerate()} className="chip flex items-center gap-1.5 hover:text-ink" data-testid="brief-outdated">
                <span className="dot bg-warn" aria-hidden /> Outdated · Regenerate
              </button>
            )
          )}
          {written && (
            <button type="button" onClick={() => void listen()} disabled={busy === "audio"} className="btn btn-sm" aria-pressed={playing}>
              {busy === "audio" ? <span className="ai-spinner" aria-hidden /> : <IconSpeaker />}
              {playing ? "Pause" : "Listen"}
            </button>
          )}
          <Popover label="Brief actions" align="right" testId="brief-menu">
            {(close) => (
              <>
                <PopoverItem onClick={() => (close(), void regenerate())}>Regenerate</PopoverItem>
                <PopoverItem onClick={() => (close(), void copy())}>Copy</PopoverItem>
                <PopoverItem onClick={() => (close(), setSource(!source))}>{source ? "Hide" : "Show"} source numbers</PopoverItem>
              </>
            )}
          </Popover>
        </>
      }
    >
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <p className="min-w-0 flex-1 text-[14px] leading-snug text-ink" data-testid="brief-headline">
          {headline ?? "…"}
        </p>
        {method}
      </div>
      <ul data-testid="attention-rows">
        {rows.slice(0, SHOWN).map((r) => (
          <AttentionRow key={r.contributor.code} row={r} selected={focus === r.contributor.code} onFocus={onFocus} />
        ))}
      </ul>
      {rows.length > SHOWN && (
        <>
          <Reveal open={all} id="attention-rest">
            <ul>
              {rows.slice(SHOWN).map((r) => (
                <AttentionRow key={r.contributor.code} row={r} selected={focus === r.contributor.code} onFocus={onFocus} />
              ))}
            </ul>
          </Reveal>
          <div className="px-4 py-2.5">
            <button type="button" className="disclosure text-[12.5px] text-accent-ink" aria-expanded={all} aria-controls="attention-rest"
              onClick={() => setAll(!all)} data-testid="attention-toggle">
              <Chevron />
              {all ? "Show fewer" : `Show all ${rows.length}`}
            </button>
          </div>
        </>
      )}
      <Reveal open={source} id="brief-source">
        <pre className="scrollbar-thin m-4 mt-0 max-h-64 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-[11px] text-muted">
          {JSON.stringify(state?.brief?.stats ?? state?.facts ?? {}, null, 2)}
        </pre>
      </Reveal>
    </Section>
  );
}

/** The brief's contributors in its order, then everyone else to investigate or watch. */
function attentionRows(overview: Overview | null, written: NonNullable<BriefState["brief"]>["items"] | null): Row[] {
  if (!overview) return [];
  const people = new Map(overview.contributors.map((c) => [c.code, c]));
  const rows: Row[] = [];
  for (const item of written?.items ?? []) {
    const contributor = people.get(item.contributor_code);
    if (contributor) rows.push({ contributor, action: item.action, finding: item.finding });
  }
  const listed = new Set(rows.map((r) => r.contributor.code));
  for (const c of overview.contributors) {
    if (c.status === "ok" || listed.has(c.code)) continue;
    const signal = mainSignal(c.checks_fired);
    rows.push({
      contributor: c,
      action: signal ? CHECK_ACTION_SHORT[signal] : "Look at their latest submissions",
      finding: `${c.flagged} of ${c.submissions} flagged (${fmtPct(c.flag_rate)})${signal ? `, mostly ${CHECK_LABEL[signal]}` : ""}.`,
    });
  }
  return rows;
}

function templateHeadline(o: Overview): string {
  const n = o.contributors.filter((c) => c.status === "investigate").length;
  const who = n === 0 ? "No contributor to investigate" : n === 1 ? "One contributor to investigate" : `${n} contributors to investigate`;
  return `${who}; ${o.yesterday.flagged} of ${o.yesterday.received} flagged yesterday.`;
}

function AttentionRow({ row, selected, onFocus }: { row: Row; selected: boolean; onFocus: (code: string | null) => void }) {
  const c = row.contributor;
  const ranked = rankChecks(c.checks_fired);
  const main = mainSignal(c.checks_fired);
  const others = ranked.filter(([k]) => k !== main).length;
  const { triggerProps, tip } = useTip(row.finding, { delay: 350 });
  return (
    <li className={`border-b border-line px-4 py-2.5 last:border-b-0 ${selected ? "bg-accent-soft" : ""}`} data-code={c.code}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button type="button" onClick={() => onFocus(selected ? null : c.code)} aria-pressed={selected}
          className="min-w-0 truncate text-left hover:text-accent-ink" title="Show on the map">
          <b className="font-semibold text-ink">{c.display_name}</b> <span className="font-mono text-muted">{c.code}</span>
        </button>
        <span className="truncate text-[12px] text-muted">{c.area}</span>
        <span className="ml-auto flex flex-none items-center gap-1.5">
          <span className="font-mono text-[12px] text-ink-2 tabular-nums" aria-label={`${c.flagged} of ${c.submissions} flagged`}>
            {c.flagged}/{c.submissions}
          </span>
          {main && <span className="chip">{CHECK_TITLE[main]}</span>}
          {others > 0 && <span className="chip">+{others}</span>}
          <Link href={`/app/queue?contributor=${c.code}`} className="btn btn-sm">
            Review
          </Link>
        </span>
      </div>
      <p className="mt-0.5 truncate text-[12.5px] text-ink-2" tabIndex={0} {...triggerProps} data-testid="attention-action">
        → {row.action}
      </p>
      {tip}
    </li>
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
