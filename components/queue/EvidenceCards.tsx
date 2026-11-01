"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { api } from "@/lib/api";
import { CHECK_TITLE, COLORS, SOURCE_LABEL } from "@/lib/checks";
import { fmtDuration, fmtLocalDate, fmtPct, fmtTime, localDate, localHours, median, shortId } from "@/lib/format";
import type { CheckResult, MapData, MapPoint, SubmissionDetail } from "@/lib/types";

const SATISFACTION_ITEMS = ["Reliability", "Distance", "Cost", "Quality", "Waiting", "Safety", "Hours", "Overall"];

interface CardProps {
  check: CheckResult;
  detail: SubmissionDetail;
  map: MapData | null;
  tz: string;
}

function Card({ check, children }: { check: CheckResult; children: ReactNode }) {
  return (
    <section className="panel p-4" aria-label={CHECK_TITLE[check.key]}>
      <div className="mb-3 flex items-center gap-2">
        <span className="dot bg-warn" aria-hidden />
        <h3 className="text-[13px] font-medium text-ink">{CHECK_TITLE[check.key]}</h3>
        <span className="ml-auto font-mono text-[11px] text-faint">+{check.weight}</span>
      </div>
      {children}
    </section>
  );
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

export function EvidenceCard(props: CardProps) {
  switch (props.check.key) {
    case "too_fast":
      return <TooFast {...props} />;
    case "same_spot":
      return <SameSpot {...props} />;
    case "copied_text":
      return <CopiedText {...props} />;
    case "straight_lining":
      return <StraightLining {...props} />;
    case "voice_vs_form":
      return <VoiceVsForm {...props} />;
    case "off_hours":
      return <OffHours {...props} />;
    case "shared_device":
      return <SharedDevice {...props} />;
    case "burst":
      return <Burst {...props} />;
  }
}

// too_fast ---------------------------------------------------------------------------

function TooFast({ check, detail, map }: CardProps) {
  const e = check.evidence;
  const duration = num(e.duration_sec);
  const threshold = num(e.threshold_sec);
  const own = num(e.contributor_median_sec);
  const kind = detail.contributor.kind;
  const kindMedian = useMemo(
    () => median((map?.points ?? []).filter((p) => p.kind === kind && p.duration_sec != null).map((p) => p.duration_sec!)),
    [map, kind],
  );
  const max = Math.max(duration, threshold, own, kindMedian ?? 0) * 1.12 || 1;
  const markers = [
    { label: "threshold", value: threshold, color: COLORS.crit, dashed: true },
    { label: `${kind} median`, value: kindMedian, color: COLORS.muted },
    { label: `${detail.contributor.code} median`, value: own, color: COLORS.accent },
  ];
  return (
    <Card check={check}>
      <p className="text-[13px] text-ink-2">
        <span className="font-display text-xl font-semibold text-warn">{fmtDuration(duration)}</span>{" "}
        <span className="text-muted">
          against a {fmtDuration(threshold)} minimum for {kind}s. Typical {kind}: {fmtDuration(kindMedian)}.
        </span>
      </p>
      <div className="relative mt-4 h-9" aria-hidden>
        <div className="absolute inset-x-0 top-3 h-2 rounded-full bg-white/[0.05]" />
        <div className="absolute top-3 left-0 h-2 rounded-full bg-warn" style={{ width: `${(duration / max) * 100}%` }} />
        {markers.map((m) =>
          m.value == null ? null : (
            <div key={m.label} className="absolute top-0 h-8" style={{ left: `${(m.value / max) * 100}%` }}>
              <div className="h-7 border-l-2" style={{ borderColor: m.color, borderStyle: m.dashed ? "dashed" : "solid" }} />
            </div>
          ),
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted">
        {markers.map((m) => (
          <span key={m.label} className="flex items-center gap-1.5">
            <span className="h-3 border-l-2" style={{ borderColor: m.color, borderStyle: m.dashed ? "dashed" : "solid" }} />
            {m.label} {fmtDuration(m.value)}
          </span>
        ))}
      </div>
    </Card>
  );
}

// same_spot ---------------------------------------------------------------------------

function SameSpot({ check, detail, map, tz }: CardProps) {
  const e = check.evidence as {
    radius_m: number;
    local_date: string;
    neighbour_count: number;
    neighbours: { submission_id: string; distance_m: number; captured_at: string }[];
  };
  const target = detail.submission;
  const sameDay = useMemo(
    () =>
      (map?.points ?? []).filter(
        (p) => p.code === detail.contributor.code && localDate(p.captured_at, tz) === e.local_date && p.id !== target.id,
      ),
    [map, detail.contributor.code, e.local_date, target.id, tz],
  );
  const neighbourIds = new Set(e.neighbours.map((n) => n.submission_id));
  const lat0 = target.lat ?? 0;
  const lng0 = target.lng ?? 0;
  const toMetres = (p: MapPoint) => ({
    x: (p.lng - lng0) * 111320 * Math.cos((lat0 * Math.PI) / 180),
    y: (p.lat - lat0) * 110574,
  });
  const placed = sameDay.map((p) => ({ p, ...toMetres(p) }));
  // Square-root distance scale out to four times the radius: the ring gets room and
  // interviews a few metres apart separate from the target. Farther ones sit on the edge.
  const extent = e.radius_m * 4;
  const size = 220;
  const outer = size / 2 - 12;
  const radial = (d: number) => outer * Math.sqrt(Math.min(d, extent) / extent);
  const project = (x: number, y: number) => {
    const d = Math.hypot(x, y);
    if (d === 0) return { cx: 0, cy: 0, beyond: false };
    const r = radial(d);
    return { cx: (x / d) * r, cy: (-y / d) * r, beyond: d > extent };
  };
  const ring = radial(e.radius_m);
  return (
    <Card check={check}>
      <div className="flex flex-col gap-4 sm:flex-row">
        <figure className="flex-none">
          <svg viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} className="h-[220px] w-[220px]" role="img"
            aria-label={`${e.neighbour_count} other interviews within ${e.radius_m} metres on the same day`}>
            <rect x={-size / 2} y={-size / 2} width={size} height={size} rx="10" fill="rgba(255,255,255,0.02)" />
            <circle r={outer} fill="none" stroke="rgba(255,255,255,0.06)" />
            <circle r={ring} fill="rgba(235,90,87,0.07)" stroke={COLORS.crit} strokeDasharray="4 4" />
            {placed.map(({ p, x, y }) => {
              const near = neighbourIds.has(p.id);
              const { cx, cy, beyond } = project(x, y);
              return beyond ? (
                <circle key={p.id} cx={cx} cy={cy} r={3} fill="#0e0f11" stroke={COLORS.pass} />
              ) : (
                <circle key={p.id} cx={cx} cy={cy} r={near ? 4.5 : 3.2} fill={near ? COLORS.warn : COLORS.pass} stroke="#08090a" />
              );
            })}
            <circle r="5.5" fill={COLORS.crit} stroke="#f1f2f4" strokeWidth="1.5" />
            <text x={ring * 0.72 + 3} y={-ring * 0.72 - 3} fill={COLORS.muted} fontSize="10">
              {Math.round(e.radius_m)} m
            </text>
            <text x={outer * 0.72 + 2} y={-outer * 0.72 - 2} fill={COLORS.faint} fontSize="9.5">
              {Math.round(extent)} m+
            </text>
          </svg>
          <figcaption className="mt-1 text-center text-[10.5px] text-faint">square-root scale · hollow = farther away</figcaption>
        </figure>
        <div className="min-w-0 flex-1 text-[13px]">
          <p className="text-ink-2">
            {e.neighbour_count} other {e.neighbour_count === 1 ? "interview" : "interviews"} by {detail.contributor.code} within{" "}
            {Math.round(e.radius_m)} m on {fmtLocalDate(e.local_date)}. {sameDay.length + 1} that day in total.
          </p>
          <ul className="mt-2 space-y-1 text-[12.5px]">
            {e.neighbours.slice(0, 8).map((n) => (
              <li key={n.submission_id} className="flex items-center gap-2">
                <span className="dot bg-warn" aria-hidden />
                <Link href={`/app/queue/${n.submission_id}`} className="font-mono text-ink hover:text-accent">
                  {shortId(n.submission_id)}
                </Link>
                <span className="text-muted">{fmtTime(n.captured_at, tz)}</span>
                <span className="ml-auto tabular-nums text-muted">{n.distance_m} m</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

// copied_text -------------------------------------------------------------------------

function Highlighted({ text, words }: { text: string; words: Set<string> }) {
  const parts = text.split(/(\b[\w']+\b)/);
  return (
    <>
      {parts.map((part, i) =>
        words.has(part.toLowerCase()) ? (
          <mark key={i} className="rounded-[3px] bg-warn/20 px-0.5 text-ink">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function CopiedText({ check, detail }: CardProps) {
  const best = check.evidence.best_match as
    | { submission_id: string; similarity: number; relation: string; shared_words: string[] }
    | null;
  const [partner, setPartner] = useState<{ id: string; text: string; code: string } | null>(null);
  useEffect(() => {
    if (!best) return;
    let cancelled = false;
    api.submission(best.submission_id).then(
      (d) => !cancelled && setPartner({ id: d.submission.id, text: d.submission.answers.open_text ?? "", code: d.contributor.code }),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [best]);
  if (!best) return null;
  const words = new Set(best.shared_words);
  const shown = partner?.id === best.submission_id ? partner : null;
  return (
    <Card check={check}>
      <p className="text-[13px] text-muted">
        <span className="font-display text-xl font-semibold text-warn">{fmtPct(best.similarity)}</span> similar to{" "}
        <Link href={`/app/queue/${best.submission_id}`} className="font-mono text-ink hover:text-accent">
          {shortId(best.submission_id)}
        </Link>{" "}
        ({best.relation === "same_device" ? "same phone, another account" : "same contributor"}). Shared words highlighted.
      </p>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {[
          { label: `This submission · ${detail.contributor.code}`, text: detail.submission.answers.open_text ?? "" },
          { label: shown ? `${shortId(shown.id)} · ${shown.code}` : "Matched submission", text: shown?.text ?? "Loading…" },
        ].map((side) => (
          <div key={side.label} className="rounded-lg border border-line bg-black/20 p-3">
            <p className="mb-1.5 text-[11px] text-faint">{side.label}</p>
            <p className="text-[13px] leading-relaxed text-ink-2">
              <Highlighted text={side.text} words={words} />
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

// straight_lining ---------------------------------------------------------------------

function StraightLining({ check }: CardProps) {
  const values = (check.evidence.values as number[]) ?? [];
  return (
    <Card check={check}>
      <p className="mb-3 text-[13px] text-muted">All 8 satisfaction answers are the same.</p>
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-8">
        {values.map((v, i) => (
          <div key={i} className="rounded-md border border-line bg-black/20 px-1 py-1.5 text-center">
            <p className="font-display text-base font-semibold text-warn">{v}</p>
            <p className="truncate text-[10px] text-faint">{SATISFACTION_ITEMS[i]}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

// voice_vs_form ------------------------------------------------------------------------

function VoiceVsForm({ check, detail }: CardProps) {
  const e = check.evidence as { form_source: string; voice_source: string; matched_keyword: string; keyword_position: number };
  const transcript = detail.submission.voice_transcript ?? "";
  const at = e.keyword_position ?? transcript.toLowerCase().indexOf(e.matched_keyword);
  const end = at + (e.matched_keyword?.length ?? 0);
  return (
    <Card check={check}>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-line bg-black/20 p-3">
          <p className="text-[11px] text-faint">Form answer</p>
          <p className="mt-1 text-[13px] text-ink">{SOURCE_LABEL[e.form_source] ?? e.form_source}</p>
        </div>
        <div className="rounded-lg border border-warn/30 bg-warn/[0.05] p-3">
          <p className="text-[11px] text-faint">Voice note says</p>
          <p className="mt-1 text-[13px] text-warn">{SOURCE_LABEL[e.voice_source] ?? e.voice_source}</p>
        </div>
      </div>
      <blockquote className="mt-3 border-l-2 border-line-strong pl-3 text-[13px] leading-relaxed text-ink-2">
        “{at >= 0 ? (
          <>
            {transcript.slice(0, at)}
            <mark className="rounded-[3px] bg-warn/25 px-0.5 text-ink">{transcript.slice(at, end)}</mark>
            {transcript.slice(end)}
          </>
        ) : (
          transcript
        )}”
      </blockquote>
      <p className="mt-2 text-[11.5px] text-faint">Keyword match: the first source word in the transcript decides. Round 7 replaces this with a model.</p>
    </Card>
  );
}

// off_hours ------------------------------------------------------------------------------

function OffHours({ check, detail, tz }: CardProps) {
  const hour = localHours(detail.submission.captured_at, tz);
  const pct = (h: number) => `${(h / 24) * 100}%`;
  return (
    <Card check={check}>
      <p className="text-[13px] text-muted">
        Captured at <span className="font-display text-xl font-semibold text-warn">{fmtTime(detail.submission.captured_at, tz)}</span>{" "}
        local time. Fieldwork runs roughly 08:00 to 19:30; the check fires from 21:00 to 06:00.
      </p>
      <div className="relative mt-4 h-8" aria-hidden>
        <div className="absolute inset-x-0 top-2.5 h-3 rounded-full bg-white/[0.04]" />
        <div className="absolute top-2.5 h-3 rounded-l-full bg-crit/25" style={{ left: 0, width: pct(6) }} />
        <div className="absolute top-2.5 h-3 rounded-r-full bg-crit/25" style={{ left: pct(21), width: pct(3) }} />
        <div className="absolute top-2.5 h-3 bg-ok/25" style={{ left: pct(8), width: pct(11.5) }} />
        <div className="absolute top-0 h-8 border-l-2 border-warn" style={{ left: pct(hour) }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10.5px] text-faint">
        {["00", "06", "12", "18", "24"].map((h) => (
          <span key={h}>{h}:00</span>
        ))}
      </div>
    </Card>
  );
}

// shared_device ----------------------------------------------------------------------------

function SharedDevice({ check }: CardProps) {
  const e = check.evidence as { device_id: string; accounts: { code: string; kind: string; submissions: number }[] };
  return (
    <Card check={check}>
      <p className="text-[13px] text-muted">
        Phone <span className="font-mono text-ink-2">{e.device_id}</span> has submitted for {e.accounts.length} accounts.
      </p>
      <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
        {e.accounts.map((a) => (
          <li key={a.code} className="flex items-center gap-3 px-3 py-2 text-[13px]">
            <span className="font-mono text-ink">{a.code}</span>
            <span className="text-muted capitalize">{a.kind}</span>
            <span className="ml-auto tabular-nums text-muted">{a.submissions} submissions</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// burst --------------------------------------------------------------------------------------

function Burst({ check, detail, map, tz }: CardProps) {
  const e = check.evidence as { window_minutes: number; window_start: string; window_end: string; submission_ids: string[]; max_in_window: number };
  const start = new Date(e.window_start).getTime();
  const end = new Date(e.window_end).getTime();
  const byId = useMemo(() => new Map((map?.points ?? []).map((p) => [p.id, p])), [map]);
  const times = e.submission_ids
    .map((id) => ({ id, at: byId.get(id)?.captured_at ?? (id === detail.submission.id ? detail.submission.captured_at : null) }))
    .filter((t): t is { id: string; at: string } => Boolean(t.at));
  return (
    <Card check={check}>
      <p className="text-[13px] text-muted">
        <span className="font-display text-xl font-semibold text-warn">{e.max_in_window}</span> submissions by{" "}
        {detail.contributor.code} inside {e.window_minutes} minutes ({fmtTime(e.window_start, tz)}–{fmtTime(e.window_end, tz)}).
      </p>
      <div className="relative mt-4 h-10" aria-hidden>
        <div className="absolute inset-x-0 top-4 h-px bg-line-strong" />
        {times.map((t) => {
          const left = ((new Date(t.at).getTime() - start) / Math.max(end - start, 1)) * 100;
          const current = t.id === detail.submission.id;
          return (
            <span
              key={t.id}
              className="absolute top-2 h-4 w-0.5 rounded-full"
              style={{ left: `${Math.min(100, Math.max(0, left))}%`, background: current ? COLORS.crit : COLORS.warn, height: current ? 22 : 16, top: current ? 5 : 8 }}
            />
          );
        })}
      </div>
      <div className="flex justify-between font-mono text-[10.5px] text-faint">
        <span>{fmtTime(e.window_start, tz)}</span>
        <span>{fmtTime(e.window_end, tz)}</span>
      </div>
    </Card>
  );
}
