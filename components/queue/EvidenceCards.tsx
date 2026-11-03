"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { api } from "@/lib/api";
import { CHECK_STRONG, CHECK_TITLE, COLORS, SOURCE_LABEL } from "@/lib/checks";
import { fmtDuration, fmtLocalDate, fmtPct, fmtTime, localDate, localHours, median, shortId } from "@/lib/format";
import type { CheckResult, MapData, MapPoint, SubmissionDetail } from "@/lib/types";

const SATISFACTION_ITEMS = ["Reliability", "Distance", "Cost", "Quality", "Waiting", "Safety", "Hours", "Overall"];

interface CardProps {
  check: CheckResult;
  detail: SubmissionDetail;
  map: MapData | null;
  tz: string;
}

/** The prototype's evidence card: hairline box, coloured left edge, title with its weight. */
function Card({ check, children, ai }: { check: CheckResult; children: ReactNode; ai?: boolean }) {
  return (
    <section className={`card ${CHECK_STRONG.has(check.key) ? "card-crit" : ""}`} aria-label={CHECK_TITLE[check.key]}>
      <h3>
        {CHECK_TITLE[check.key]}
        {ai && (
          <span className="ai-tag" title="A model judged this; the check read its stored verdict">
            AI
          </span>
        )}
        <span className="w">+{check.weight}</span>
      </h3>
      {children}
    </section>
  );
}

/** Who decided: the model (with confidence, model id and latency) or the rule. */
function DecidedBy({ model, latency, confidence, rule }: { model?: string; latency?: number | null; confidence?: number; rule?: string }) {
  return (
    <p className="mt-2 text-[12px] !text-faint">
      {model ? (
        <>
          Decided by <span className="font-mono">{model}</span>
          {confidence != null && <> · confidence {fmtPct(confidence)}</>}
          {latency != null && <> · {latency} ms</>}
        </>
      ) : (
        rule
      )}
    </p>
  );
}

const B = ({ children }: { children: ReactNode }) => <b className="font-mono font-medium text-ink">{children}</b>;

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
    case "outside_area":
      return <OutsideArea {...props} />;
    case "clock_skew":
      return <ClockSkew {...props} />;
  }
}

// clock_skew -----------------------------------------------------------------------------

function ClockSkew({ check }: CardProps) {
  const e = check.evidence as { skew_minutes: number; direction: string; basis: string; limit_minutes: number };
  const minutes = Math.abs(e.skew_minutes);
  const size = minutes >= 90 ? `${(minutes / 60).toFixed(1)} h` : `${Math.round(minutes)} min`;
  return (
    <Card check={check}>
      <p>
        The phone&apos;s clock was <B>{size} {e.direction === "ahead" ? "ahead of" : "behind"}</B> the server&apos;s
        {e.basis === "sync" ? " when it synced" : ": it recorded a capture time after the server received it"}.
      </p>
      <p className="mt-1 text-[12px] text-muted">
        Every time this phone reported is off by about as much. A clock set back can make night work look like daytime.
      </p>
      <p className="mt-2 text-[12px] !text-faint">
        Decided by the clock rule: more than {e.limit_minutes} minutes apart. Corroboration only; a late sync never fires it.
      </p>
    </Card>
  );
}

// outside_area ---------------------------------------------------------------------------

function OutsideArea({ check, detail }: CardProps) {
  const e = check.evidence as { area: string; distance: string; distance_m: number; tolerance_m: number; band: string };
  const s = detail.submission;
  return (
    <Card check={check}>
      <p>
        Recorded <B>{e.distance}</B> outside {detail.contributor.code}&apos;s assigned area, <B>{e.area}</B>.
      </p>
      <p className="mt-1 text-[12px] text-muted">
        GPS <span className="font-mono">{s.lat?.toFixed(5)}, {s.lng?.toFixed(5)}</span>
        {s.gps_accuracy_m != null && <> · accuracy ±{Math.round(s.gps_accuracy_m)} m</>}
      </p>
      <p className="mt-2 text-[12px] !text-faint">
        Decided by the area rule: outside the boundary by more than the GPS error (±{Math.round(e.tolerance_m)} m).
        {e.band === "near" ? " Within 1 km it only corroborates other checks." : ""}
      </p>
    </Card>
  );
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
      <p>
        Took <B>{fmtDuration(duration)}</B>. Typical {kind}: {fmtDuration(kindMedian)}; the check flags anything under{" "}
        {fmtDuration(threshold)}.
      </p>
      <div className="relative mt-2 h-7 max-w-[420px]" aria-hidden>
        <div className="absolute inset-x-0 top-3 h-1 rounded-sm bg-white/[0.07]" />
        <div className="absolute top-3 left-0 h-1 rounded-sm bg-crit" style={{ width: `${(duration / max) * 100}%` }} />
        {markers.map((m) =>
          m.value == null ? null : (
            <div key={m.label} className="absolute top-0.5" style={{ left: `${(m.value / max) * 100}%` }}>
              <div className="h-6 border-l-2" style={{ borderColor: m.color, borderStyle: m.dashed ? "dashed" : "solid" }} />
            </div>
          ),
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-faint">
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
          <svg viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} className="mt-1.5 h-[220px] w-[220px] rounded-md border border-line bg-bg" role="img"
            aria-label={`${e.neighbour_count} other interviews within ${e.radius_m} metres on the same day`}>
            <circle r={outer} fill="none" stroke="rgba(255,255,255,0.06)" />
            <circle r={ring} fill={COLORS.crit} fillOpacity="0.1" stroke={COLORS.crit} strokeOpacity="0.7" strokeDasharray="3 3" />
            {placed.map(({ p, x, y }) => {
              const near = neighbourIds.has(p.id);
              const { cx, cy, beyond } = project(x, y);
              return beyond ? (
                <circle key={p.id} cx={cx} cy={cy} r={3} fill="#08090a" stroke={COLORS.pass} />
              ) : (
                <circle key={p.id} cx={cx} cy={cy} r={3} fill={near ? COLORS.crit : COLORS.pass} fillOpacity="0.9" />
              );
            })}
            <circle r="4.5" fill={COLORS.accent} fillOpacity="0.9" />
            <text x={ring * 0.72 + 3} y={-ring * 0.72 - 3} fill={COLORS.muted} fontSize="10">
              {Math.round(e.radius_m)} m
            </text>
            <text x={outer * 0.72 + 2} y={-outer * 0.72 - 2} fill={COLORS.faint} fontSize="9.5">
              {Math.round(extent)} m+
            </text>
          </svg>
          <figcaption className="mt-1 text-center text-[10.5px] text-faint">square-root scale · hollow = farther away</figcaption>
        </figure>
        <div className="min-w-0 flex-1">
          <p>
            <B>{e.neighbour_count}</B> other {e.neighbour_count === 1 ? "interview" : "interviews"} by {detail.contributor.code} on{" "}
            {fmtLocalDate(e.local_date)} were logged within {Math.round(e.radius_m)} m ({sameDay.length + 1} that day in total).
            Households are usually hundreds of metres apart.
          </p>
          <ul className="mt-2 space-y-1 text-[12.5px]">
            {e.neighbours.slice(0, 8).map((n) => (
              <li key={n.submission_id} className="flex items-center gap-2">
                <span className="dot bg-crit" aria-hidden />
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
          <mark key={i}>{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

interface ParaphraseEvidence {
  submission_id: string;
  relation: string;
  model: string;
  reason: string;
  similarity: number;
  other_text: string;
  latency_ms: number | null;
}

/** copied_text decided by the model: a reworded copy below the word-overlap threshold. */
function RewordedCopy({ check, detail }: CardProps) {
  const pair = (check.evidence.paraphrases as ParaphraseEvidence[])[0];
  return (
    <Card check={check} ai>
      <p>
        A <B>reworded copy</B> of{" "}
        <Link href={`/app/queue/${pair.submission_id}`} className="font-mono text-ink hover:text-accent">
          {shortId(pair.submission_id)}
        </Link>{" "}
        ({pair.relation === "same_device" ? "same phone, another account" : "same contributor"}). Character overlap{" "}
        <B>{fmtPct(pair.similarity)}</B>, below what the copy rule needs, so the model judged the pair.
      </p>
      <div className="grid gap-2 md:grid-cols-2">
        <div className="side-box">
          <span className="lbl">{shortId(detail.submission.id)} (this one)</span>
          {detail.submission.answers.open_text}
        </div>
        <div className="side-box">
          <span className="lbl">{shortId(pair.submission_id)}</span>
          {pair.other_text}
        </div>
      </div>
      <p className="mt-2">
        <span className="text-muted">Model&apos;s reason:</span> {pair.reason}
      </p>
      <DecidedBy model={pair.model} latency={pair.latency_ms} />
    </Card>
  );
}

function CopiedText(props: CardProps) {
  return props.check.evidence.decided_by === "ai_paraphrase" ? <RewordedCopy {...props} /> : <CopiedByRule {...props} />;
}

function CopiedByRule({ check, detail }: CardProps) {
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
      <p>
        <B>{fmtPct(best.similarity)}</B> word overlap with{" "}
        <Link href={`/app/queue/${best.submission_id}`} className="font-mono text-ink hover:text-accent">
          {shortId(best.submission_id)}
        </Link>{" "}
        ({best.relation === "same_device" ? "same phone, another account" : "same contributor"}).
      </p>
      <div className="grid gap-2 md:grid-cols-2">
        {[
          { label: shortId(detail.submission.id), text: detail.submission.answers.open_text ?? "" },
          { label: shown ? `${shortId(shown.id)} · ${shown.code}` : shortId(best.submission_id), text: shown?.text ?? "Loading…" },
        ].map((side) => (
          <div key={side.label} className="side-box">
            <span className="lbl">{side.label}</span>
            <Highlighted text={side.text} words={words} />
          </div>
        ))}
      </div>
      <DecidedBy rule="Decided by the copy rule: word overlap at or above the threshold." />
    </Card>
  );
}

// straight_lining ---------------------------------------------------------------------

function StraightLining({ check }: CardProps) {
  const values = (check.evidence.values as number[]) ?? [];
  return (
    <Card check={check}>
      <p>
        {check.evidence.pattern === "alternating" ? (
          <>
            All 8 satisfaction items zig-zag between <B>{values[0]}</B> and <B>{values[1]}</B>. Real respondents almost
            always vary.
          </>
        ) : (
          <>
            All 8 satisfaction items answered <B>{values[0]}</B>. Real respondents almost always vary.
          </>
        )}
      </p>
      <div className="likert">
        {values.map((v, i) => (
          <span key={i} title={SATISFACTION_ITEMS[i]}>
            {v}
          </span>
        ))}
      </div>
    </Card>
  );
}

// voice_vs_form ------------------------------------------------------------------------

interface VoiceVerdict {
  decided_by: "ai";
  model: string;
  confidence: number;
  form_says: string;
  voice_says: string;
  quote: string;
  explanation: string;
  latency_ms: number | null;
  form_source: string;
}

/** voice_vs_form decided by the model: its verdict, with the quoted span highlighted in the transcript. */
function VoiceVsFormAI({ check, detail }: CardProps) {
  const e = check.evidence as unknown as VoiceVerdict;
  const transcript = detail.submission.voice_transcript ?? "";
  const at = e.quote ? transcript.indexOf(e.quote) : -1; // stored verdicts were checked: the quote is an exact span
  return (
    <Card check={check} ai>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="side-box">
          <span className="lbl">Form says ({SOURCE_LABEL[e.form_source] ?? e.form_source})</span>
          {e.form_says}
        </div>
        <div className="side-box">
          <span className="lbl">Voice note says: {e.voice_says}</span>
          {at >= 0 ? (
            <>
              {transcript.slice(0, at)}
              <mark>{transcript.slice(at, at + e.quote.length)}</mark>
              {transcript.slice(at + e.quote.length)}
            </>
          ) : (
            transcript
          )}
        </div>
      </div>
      <p className="mt-2">{e.explanation}</p>
      <DecidedBy model={e.model} confidence={e.confidence} latency={e.latency_ms} />
    </Card>
  );
}

function VoiceVsForm(props: CardProps) {
  return props.check.evidence.decided_by === "ai" ? <VoiceVsFormAI {...props} /> : <VoiceVsFormRule {...props} />;
}

function VoiceVsFormRule({ check, detail }: CardProps) {
  const e = check.evidence as {
    form_source: string;
    voice_source: string;
    matched_keyword: string;
    keyword_position: number;
    ai?: { model: string; confidence: number; below: number };
  };
  const transcript = detail.submission.voice_transcript ?? "";
  const at = e.keyword_position ?? transcript.toLowerCase().indexOf(e.matched_keyword);
  const end = at + (e.matched_keyword?.length ?? 0);
  return (
    <Card check={check}>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="side-box">
          <span className="lbl">Form says</span>
          {SOURCE_LABEL[e.form_source] ?? e.form_source}
        </div>
        <div className="side-box">
          <span className="lbl">Voice note says ({SOURCE_LABEL[e.voice_source] ?? e.voice_source})</span>
          {at >= 0 ? (
            <>
              {transcript.slice(0, at)}
              <mark>{transcript.slice(at, end)}</mark>
              {transcript.slice(end)}
            </>
          ) : (
            transcript
          )}
        </div>
      </div>
      <DecidedBy
        rule={
          e.ai
            ? `Decided by the keyword rule: the model's verdict (confidence ${fmtPct(e.ai.confidence)}) is below the ${fmtPct(e.ai.below)} bar.`
            : "Decided by the keyword rule: the first source word in the transcript decides (no model verdict yet)."
        }
      />
    </Card>
  );
}

// off_hours ------------------------------------------------------------------------------

function OffHours({ check, detail, tz }: CardProps) {
  const hour = localHours(detail.submission.captured_at, tz);
  const pct = (h: number) => `${(h / 24) * 100}%`;
  return (
    <Card check={check}>
      <p>
        Captured at <B>{fmtTime(detail.submission.captured_at, tz)}</B> local time. Fieldwork runs roughly 08:00 to 19:30; the
        check fires from 21:00 to 06:00.
      </p>
      <div className="relative mt-2 h-8 max-w-[520px]" aria-hidden>
        <div className="absolute inset-x-0 top-2.5 h-3 rounded-full bg-white/[0.04]" />
        <div className="absolute top-2.5 h-3 rounded-l-full bg-crit/25" style={{ left: 0, width: pct(6) }} />
        <div className="absolute top-2.5 h-3 rounded-r-full bg-crit/25" style={{ left: pct(21), width: pct(3) }} />
        <div className="absolute top-2.5 h-3 bg-ok/25" style={{ left: pct(8), width: pct(11.5) }} />
        <div className="absolute top-0 h-8 border-l-2 border-warn" style={{ left: pct(hour) }} />
      </div>
      <div className="mt-1 flex max-w-[520px] justify-between font-mono text-[10.5px] text-faint">
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
      <p>
        Phone <B>{e.device_id}</B> has submitted for <B>{e.accounts.length}</B> accounts.
      </p>
      <ul className="divide-y divide-line rounded-md border border-line bg-bg">
        {e.accounts.map((a) => (
          <li key={a.code} className="flex items-center gap-3 px-2.5 py-1.5 text-[12.5px]">
            <span className="font-mono text-ink">{a.code}</span>
            <span className="text-muted capitalize">{a.kind}</span>
            <span className="ml-auto font-mono tabular-nums text-muted">{a.submissions} submissions</span>
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
      <p>
        <B>{e.max_in_window}</B> submissions by {detail.contributor.code} inside {e.window_minutes} minutes (
        {fmtTime(e.window_start, tz)}–{fmtTime(e.window_end, tz)}).
      </p>
      <div className="relative mt-2 h-10 max-w-[520px]" aria-hidden>
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
      <div className="flex max-w-[520px] justify-between font-mono text-[10.5px] text-faint">
        <span>{fmtTime(e.window_start, tz)}</span>
        <span>{fmtTime(e.window_end, tz)}</span>
      </div>
    </Card>
  );
}
