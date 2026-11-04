"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState, type FC, type ReactNode } from "react";

import { Chevron, Reveal } from "@/components/ui/Disclosure";
import { MethodChip } from "@/components/ui/Tip";
import { api } from "@/lib/api";
import { CHECK_STRONG, CHECK_TITLE, COLORS, SOURCE_LABEL } from "@/lib/checks";
import { fmtDuration, fmtLocalDate, fmtPct, fmtTime, localDate, localHours, median, shortId } from "@/lib/format";
import type { CheckKey, CheckResult, MapData, MapPoint, SubmissionDetail } from "@/lib/types";

const SATISFACTION_ITEMS = ["Reliability", "Distance", "Cost", "Quality", "Waiting", "Safety", "Hours", "Overall"];

interface CardProps {
  check: CheckResult;
  detail: SubmissionDetail;
  map: MapData | null;
  tz: string;
}

/** What one fired check says, three ways: the one-line finding, how it was decided, and the evidence. */
interface Explained {
  finding: ReactNode;
  ai: boolean;
  method: string;
  body: ReactNode;
}

const B = ({ children }: { children: ReactNode }) => <b className="font-mono font-medium text-ink">{children}</b>;

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

type RowProps = CardProps & { open: boolean; onToggle: () => void };

/**
 * One fired check in the review queue: a row with the check, its one-line finding with the key number,
 * how it was decided (Rule or AI, the method in a tooltip) and its weight; opened, the evidence.
 */
function Shell({ e, check, open, onToggle }: { e: Explained; check: CheckResult; open: boolean; onToggle: () => void }) {
  const id = useId();
  return (
    <section
      className={`ev-row ${CHECK_STRONG.has(check.key) ? "ev-crit" : ""}`}
      aria-label={CHECK_TITLE[check.key]}
      data-check={check.key}
      data-testid={`evidence-${check.key}`}
    >
      <div className="ev-head">
        <h3>
          <button type="button" className="disclosure" aria-expanded={open} aria-controls={`${id}-body`} onClick={onToggle}>
            <Chevron />
            <span className="ev-title">{CHECK_TITLE[check.key]}</span>
            <span className="ev-finding">{e.finding}</span>
          </button>
        </h3>
        <MethodChip ai={e.ai} tip={e.method} />
        <span className="ev-weight" title="Weight in the score">
          +{check.weight}
        </span>
      </div>
      <Reveal open={open} id={`${id}-body`}>
        <div className="ev-body">{e.body}</div>
      </Reveal>
    </section>
  );
}

// Each check explains itself (some read the map or fetch the copied answer); one component per check
// keeps every hook call unconditional.
const EXPLAIN: Record<CheckKey, (props: CardProps) => Explained> = {
  too_fast: useTooFast,
  same_spot: useSameSpot,
  copied_text: useCopiedText,
  straight_lining: straightLining,
  voice_vs_form: voiceVsForm,
  off_hours: offHours,
  shared_device: sharedDevice,
  burst: useBurst,
  outside_area: outsideArea,
  clock_skew: clockSkew,
};
const ROWS = {} as Record<CheckKey, FC<RowProps>>;
for (const key of Object.keys(EXPLAIN) as CheckKey[]) {
  const explain = EXPLAIN[key];
  const Row: FC<RowProps> = ({ open, onToggle, ...props }) => (
    <Shell e={explain(props)} check={props.check} open={open} onToggle={onToggle} />
  );
  Row.displayName = `EvidenceRow(${key})`;
  ROWS[key] = Row;
}

export function EvidenceRow(props: RowProps) {
  const Row = ROWS[props.check.key];
  return <Row {...props} />;
}

/** Who decided, for the AI chip's tooltip: the model, its confidence and latency. */
function byModel(model: string, confidence?: number | null, latency?: number | null): string {
  return [`Decided by ${model}`, confidence != null && `confidence ${fmtPct(confidence)}`, latency != null && `${latency} ms`]
    .filter(Boolean)
    .join(" · ");
}

// clock_skew -----------------------------------------------------------------------------

function clockSkew({ check }: CardProps): Explained {
  const e = check.evidence as { skew_minutes: number; direction: string; basis: string; limit_minutes: number };
  const minutes = Math.abs(e.skew_minutes);
  const size = minutes >= 90 ? `${(minutes / 60).toFixed(1)} h` : `${Math.round(minutes)} min`;
  return {
    finding: (
      <>
        <B>{size}</B> {e.direction === "ahead" ? "ahead" : "behind"}
      </>
    ),
    ai: false,
    method: `Clock rule: phone and server more than ${e.limit_minutes} minutes apart at sync, or a capture time after the server received it. Corroboration only; a late sync never fires it.`,
    body: (
      <p>
        {e.basis === "sync" ? "Measured at sync." : "Captured after the server received it."} Night work can look like daytime.
      </p>
    ),
  };
}

// outside_area ---------------------------------------------------------------------------

function outsideArea({ check, detail }: CardProps): Explained {
  const e = check.evidence as { area: string; distance: string; distance_m: number; tolerance_m: number; band: string };
  const s = detail.submission;
  return {
    finding: (
      <>
        <B>{e.distance}</B> outside {e.area}
      </>
    ),
    ai: false,
    method: `Area rule: outside the assigned area by more than the GPS error (±${Math.round(e.tolerance_m)} m).${e.band === "near" ? " Within 1 km it only corroborates other checks." : ""}`,
    body: (
      <p className="font-mono text-[12px]">
        {s.lat?.toFixed(5)}, {s.lng?.toFixed(5)}
        {s.gps_accuracy_m != null && <> ±{Math.round(s.gps_accuracy_m)} m</>}
      </p>
    ),
  };
}

// too_fast ---------------------------------------------------------------------------

function useTooFast({ check, detail, map }: CardProps): Explained {
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
    { label: "limit", value: threshold, color: COLORS.crit, dashed: true },
    { label: `${kind} median`, value: kindMedian, color: COLORS.muted },
    { label: `${detail.contributor.code} median`, value: own, color: COLORS.accent },
  ];
  return {
    finding: (
      <>
        <B>{fmtDuration(duration)}</B> vs {fmtDuration(threshold)}
      </>
    ),
    ai: false,
    method: `Duration rule: an ${kind} interview shorter than ${fmtDuration(threshold)} is too fast to be real.`,
    body: (
      <>
        <div className="relative mt-1 h-7 max-w-[420px]" aria-hidden>
          <div className="absolute inset-x-0 top-3 h-1 rounded-sm bg-contrast/[0.07]" />
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
      </>
    ),
  };
}

// same_spot ---------------------------------------------------------------------------

function useSameSpot({ check, detail, map, tz }: CardProps): Explained {
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
  return {
    finding: (
      <>
        <B>{e.neighbour_count}</B> within {Math.round(e.radius_m)} m
      </>
    ),
    ai: false,
    method: `Location rule: 3 or more interviews by one contributor on one day within ${Math.round(e.radius_m)} m (${fmtLocalDate(e.local_date)}: ${sameDay.length + 1} that day). Households are usually hundreds of metres apart.`,
    body: (
      <div className="flex flex-col gap-4 sm:flex-row">
        <figure className="flex-none">
          <svg viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} className="h-[220px] w-[220px] rounded-md border border-line bg-bg" role="img"
            aria-label={`${e.neighbour_count} other interviews within ${e.radius_m} metres on the same day`}>
            <circle r={outer} fill="none" className="stroke-contrast/[0.06]" />
            <circle r={ring} fill={COLORS.crit} fillOpacity="0.1" stroke={COLORS.crit} strokeOpacity="0.7" strokeDasharray="3 3" />
            {placed.map(({ p, x, y }) => {
              const near = neighbourIds.has(p.id);
              const { cx, cy, beyond } = project(x, y);
              return beyond ? (
                <circle key={p.id} cx={cx} cy={cy} r={3} fill="var(--color-bg)" stroke={COLORS.pass} />
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
        </figure>
        <div className="min-w-0 flex-1">
          <ul className="space-y-1 text-[12.5px]">
            {e.neighbours.slice(0, 4).map((n) => (
              <li key={n.submission_id} className="flex items-center gap-2">
                <span className="dot bg-crit" aria-hidden />
                <Link href={`/app/queue/${n.submission_id}`} className="font-mono text-ink hover:text-accent-ink">
                  {shortId(n.submission_id)}
                </Link>
                <span className="text-muted">{fmtTime(n.captured_at, tz)}</span>
                <span className="ml-auto tabular-nums text-muted">{n.distance_m} m</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    ),
  };
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

const relationLabel = (relation: string) => (relation === "same_device" ? "same phone, another account" : "same contributor");

function useCopiedText(props: CardProps): Explained {
  const { check, detail } = props;
  const ai = check.evidence.decided_by === "ai_paraphrase";
  const best = (ai ? null : check.evidence.best_match) as
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

  if (ai) {
    const pair = (check.evidence.paraphrases as ParaphraseEvidence[])[0];
    return {
      finding: (
        <>
          <B>reworded</B> · {shortId(pair.submission_id)}
        </>
      ),
      ai: true,
      method: `${byModel(pair.model, null, pair.latency_ms)}. A ${relationLabel(pair.relation)} answer with ${fmtPct(pair.similarity)} character overlap, below the copy rule, so the model judged the pair; alone it only corroborates.`,
      body: (
        <>
          <div className="grid gap-2 md:grid-cols-2">
            <div className="side-box">
              <span className="lbl">{shortId(detail.submission.id)} (this one)</span>
              {detail.submission.answers.open_text}
            </div>
            <div className="side-box">
              <span className="lbl">
                <Link href={`/app/queue/${pair.submission_id}`} className="hover:text-accent-ink">
                  {shortId(pair.submission_id)}
                </Link>
              </span>
              {pair.other_text}
            </div>
          </div>
          <p className="mt-2">
            <span className="text-muted">The model&apos;s reason:</span> {pair.reason}
          </p>
        </>
      ),
    };
  }
  if (!best) return { finding: "a copy", ai: false, method: "Copy rule.", body: null };
  const words = new Set(best.shared_words);
  const shown = partner?.id === best.submission_id ? partner : null;
  return {
    finding: (
      <>
        <B>{fmtPct(best.similarity)}</B> overlap · {shortId(best.submission_id)}
      </>
    ),
    ai: false,
    method: `Copy rule: word overlap with another answer (${relationLabel(best.relation)}) at or above the threshold.`,
    body: (
      <div className="grid gap-2 md:grid-cols-2">
        {[
          { label: shortId(detail.submission.id), text: detail.submission.answers.open_text ?? "", href: null },
          {
            label: shown ? `${shortId(shown.id)} · ${shown.code}` : shortId(best.submission_id),
            text: shown?.text ?? "Loading…",
            href: `/app/queue/${best.submission_id}`,
          },
        ].map((side) => (
          <div key={side.label} className="side-box">
            <span className="lbl">
              {side.href ? (
                <Link href={side.href} className="hover:text-accent-ink">
                  {side.label}
                </Link>
              ) : (
                side.label
              )}
            </span>
            <Highlighted text={side.text} words={words} />
          </div>
        ))}
      </div>
    ),
  };
}

// straight_lining ---------------------------------------------------------------------

function straightLining({ check }: CardProps): Explained {
  const values = (check.evidence.values as number[]) ?? [];
  const zigzag = check.evidence.pattern === "alternating";
  return {
    finding: zigzag ? (
      <>
        zig-zag <B>{values[0]}</B>/<B>{values[1]}</B>
      </>
    ) : (
      <>
        all 8 = <B>{values[0]}</B>
      </>
    ),
    ai: false,
    method: "Pattern rule: 8 identical satisfaction answers, or a strict two-value zig-zag. Real respondents almost always vary.",
    body: (
      <>
        <div className="likert">
          {values.map((v, i) => (
            <span key={i} title={SATISFACTION_ITEMS[i]}>
              {v}
            </span>
          ))}
        </div>
      </>
    ),
  };
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

/** The transcript with one span highlighted. */
function Marked({ text, at, length }: { text: string; at: number; length: number }) {
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + length)}</mark>
      {text.slice(at + length)}
    </>
  );
}

/** The model job for this submission failed, was skipped, or has stalled for over a minute. */
function modelUnavailable(detail: SubmissionDetail, kind: string): boolean {
  const job = detail.ai_jobs?.filter((j) => j.kind === kind).at(-1);
  if (!job) return false;
  if (job.status === "failed" || job.status === "skipped") return true;
  return (job.status === "queued" || job.status === "running") && Date.now() - Date.parse(job.created_at) > 60_000;
}

function voiceVsForm({ check, detail }: CardProps): Explained {
  const transcript = detail.submission.voice_transcript ?? "";
  if (check.evidence.decided_by === "ai") {
    const e = check.evidence as unknown as VoiceVerdict;
    const at = e.quote ? transcript.indexOf(e.quote) : -1; // stored verdicts were checked: the quote is an exact span
    return {
      finding: (
        <>
          voice <B>{e.voice_says}</B> · form {SOURCE_LABEL[e.form_source] ?? e.form_source}
        </>
      ),
      ai: true,
      method: `${byModel(e.model, e.confidence, e.latency_ms)}. The highlighted quote is an exact span of the transcript.`,
      body: (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="side-box">
              <span className="lbl">Form says ({SOURCE_LABEL[e.form_source] ?? e.form_source})</span>
              {e.form_says}
            </div>
            <div className="side-box">
              <span className="lbl">Voice note says: {e.voice_says}</span>
              <Marked text={transcript} at={at} length={e.quote.length} />
            </div>
          </div>
          <p className="mt-2">{e.explanation}</p>
        </>
      ),
    };
  }
  const e = check.evidence as {
    form_source: string;
    voice_source: string;
    matched_keyword: string;
    keyword_position: number;
    ai?: { model: string; confidence: number; below: number };
  };
  const at = e.keyword_position ?? transcript.toLowerCase().indexOf(e.matched_keyword);
  const unavailable = modelUnavailable(detail, "consistency");
  return {
    finding: (
      <>
        voice <B>{SOURCE_LABEL[e.voice_source] ?? e.voice_source}</B> · form {SOURCE_LABEL[e.form_source] ?? e.form_source}
      </>
    ),
    ai: false,
    method: e.ai
      ? `Keyword rule: the model's verdict (confidence ${fmtPct(e.ai.confidence)}) is below the ${fmtPct(e.ai.below)} bar, so the first source word in the transcript decides.`
      : unavailable
        ? "Checked by rules (AI unavailable): the first source word in the transcript decides."
        : "Keyword rule: the first source word in the transcript decides (no model verdict yet).",
    body: (
      <>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="side-box">
            <span className="lbl">Form says</span>
            {SOURCE_LABEL[e.form_source] ?? e.form_source}
          </div>
          <div className="side-box">
            <span className="lbl">Voice note says ({SOURCE_LABEL[e.voice_source] ?? e.voice_source})</span>
            <Marked text={transcript} at={at} length={e.matched_keyword?.length ?? 0} />
          </div>
        </div>
        {unavailable && <p className="mt-2 text-[12px] !text-muted">Checked by rules (AI unavailable).</p>}
      </>
    ),
  };
}

// off_hours ------------------------------------------------------------------------------

function offHours({ detail, tz }: CardProps): Explained {
  const hour = localHours(detail.submission.captured_at, tz);
  const pct = (h: number) => `${(h / 24) * 100}%`;
  return {
    finding: (
      <>
        <B>{fmtTime(detail.submission.captured_at, tz)}</B> vs 21:00–06:00
      </>
    ),
    ai: false,
    method: "Time rule: captured between 21:00 and 06:00 local time. Fieldwork runs roughly 08:00 to 19:30.",
    body: (
      <>
        <div className="relative mt-1 h-8 max-w-[520px]" aria-hidden>
          <div className="absolute inset-x-0 top-2.5 h-3 rounded-full bg-contrast/[0.04]" />
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
      </>
    ),
  };
}

// shared_device ----------------------------------------------------------------------------

function sharedDevice({ check }: CardProps): Explained {
  const e = check.evidence as { device_id: string; accounts: { code: string; kind: string; submissions: number }[] };
  return {
    finding: (
      <>
        <B>{e.accounts.length}</B> accounts · 1 phone
      </>
    ),
    ai: false,
    method: "Device rule: one phone submitting for more than one account.",
    body: (
      <>
        <ul className="divide-y divide-line rounded-md border border-line bg-bg" aria-label={`Phone ${e.device_id}`}>
          {e.accounts.map((a) => (
            <li key={a.code} className="flex items-center gap-3 px-2.5 py-1.5 text-[12.5px]">
              <span className="font-mono text-ink">{a.code}</span>
              <span className="text-muted capitalize">{a.kind}</span>
              <span className="ml-auto font-mono tabular-nums text-muted">{a.submissions} submissions</span>
            </li>
          ))}
        </ul>
      </>
    ),
  };
}

// burst --------------------------------------------------------------------------------------

function useBurst({ check, detail, map, tz }: CardProps): Explained {
  const e = check.evidence as { window_minutes: number; window_start: string; window_end: string; submission_ids: string[]; max_in_window: number };
  const start = new Date(e.window_start).getTime();
  const end = new Date(e.window_end).getTime();
  const byId = useMemo(() => new Map((map?.points ?? []).map((p) => [p.id, p])), [map]);
  const times = e.submission_ids
    .map((id) => ({ id, at: byId.get(id)?.captured_at ?? (id === detail.submission.id ? detail.submission.captured_at : null) }))
    .filter((t): t is { id: string; at: string } => Boolean(t.at));
  return {
    finding: (
      <>
        <B>{e.max_in_window}</B> in {e.window_minutes} min
      </>
    ),
    ai: false,
    method: `Rate rule: many submissions by one contributor inside one hour. The tall mark is this one.`,
    body: (
      <>
        <div className="relative h-10 max-w-[520px]" aria-hidden>
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
      </>
    ),
  };
}

