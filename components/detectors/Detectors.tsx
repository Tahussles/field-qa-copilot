"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";
import { CHECK_DESCRIPTION, CHECK_ORDER, CHECK_TITLE, COLORS } from "@/lib/checks";
import { fmtPct } from "@/lib/format";
import type { CheckKey, EvaluateResult, HardEval } from "@/lib/types";

interface Knobs {
  tooFastMin: number;
  radius: number;
  similarity: number;
  threshold: number;
}

const DEFAULTS: Knobs = { tooFastMin: 12, radius: 50, similarity: 0.8, threshold: 2 };

const SLIDERS: { key: keyof Knobs; label: string; min: number; max: number; step: number; format: (v: number) => string; help: string }[] = [
  { key: "tooFastMin", label: "Too fast", min: 4, max: 24, step: 1, format: (v) => `${v} min`, help: "Flag enumerator interviews shorter than this" },
  { key: "radius", label: "Same spot", min: 10, max: 200, step: 5, format: (v) => `${v} m`, help: "3+ interviews, same day, within this radius" },
  { key: "similarity", label: "Copied text", min: 0.5, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, help: "Word overlap with another of their answers" },
  { key: "threshold", label: "Send to review at", min: 1, max: 8, step: 0.5, format: (v) => String(v), help: "Combined score needed to enter the queue" },
];

/** Percent with a bar; green when good, red when weak (prototype thresholds). */
function PctBar({ value, good, testId }: { value: number | null | undefined; good: number; testId?: string }) {
  const v = value ?? 0;
  const color = value == null ? undefined : v >= good ? COLORS.ok : v >= good / 2 ? COLORS.warn : COLORS.crit;
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 font-mono tabular-nums" data-testid={testId}>
        {value == null ? "—" : `${Math.round(v * 100)}%`}
      </span>
      <div className="bar max-w-[96px]" aria-hidden>
        <i style={{ width: `${Math.round(v * 100)}%`, background: color }} />
      </div>
    </div>
  );
}

function toParams(k: Knobs) {
  return {
    too_fast_min_minutes: { enumerator: k.tooFastMin },
    same_spot_radius_m: k.radius,
    copy_similarity: k.similarity,
    review_threshold: k.threshold,
  };
}

export function Detectors() {
  const [knobs, setKnobs] = useState<Knobs>(DEFAULTS);
  const [result, setResult] = useState<EvaluateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const request = useRef(0);

  useEffect(() => {
    const id = ++request.current;
    const timer = window.setTimeout(() => {
      setPending(true);
      api.evaluate(toParams(knobs)).then(
        (r) => {
          if (id !== request.current) return;
          setResult(r);
          setError(null);
          setPending(false);
        },
        (e: Error) => {
          if (id !== request.current) return;
          setError(e.message);
          setPending(false);
        },
      );
    }, 280);
    return () => window.clearTimeout(timer);
  }, [knobs]);

  const changed = (Object.keys(DEFAULTS) as (keyof Knobs)[]).some((k) => knobs[k] !== DEFAULTS[k]);

  return (
    <div className="flex flex-col gap-5">
      {error && <p className="panel px-4 py-3 text-[13px] text-crit">{error}</p>}
      <section aria-label="Tune the detectors" className="panel overflow-hidden" aria-busy={pending}>
        <div className="ph">
          <h2>Tune the detectors</h2>
          <span className="flex items-center gap-3">
            <span className="ph-caption">
              {result ? `${result.combined.fabricated} planted fakes among ${result.combined.submissions} submissions` : "Scoring…"}
            </span>
            <button type="button" disabled={!changed} onClick={() => setKnobs(DEFAULTS)} className="btn btn-sm btn-ghost">
              Reset
            </button>
          </span>
        </div>
        <p className="max-w-[76ch] px-4 pt-3.5 text-muted">
          Every synthetic submission is labelled genuine or fabricated, because the fraud was planted on purpose. That lets each check
          be scored. A stricter check catches more fakes but spends more reviewer time on genuine interviews. Nothing here changes the
          live queue.
        </p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-[18px] p-4">
          {SLIDERS.map((s) => (
            <div key={s.key}>
              <label htmlFor={`slider-${s.key}`} className="mb-1.5 flex justify-between text-[13px] font-medium">
                {s.label}
                <span className="font-mono text-accent" data-testid={`value-${s.key}`}>
                  {s.format(knobs[s.key])}
                </span>
              </label>
              <input
                id={`slider-${s.key}`}
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={knobs[s.key]}
                onChange={(e) => setKnobs((k) => ({ ...k, [s.key]: Number(e.target.value) }))}
                className="w-full accent-[#7c84f8]"
              />
              <small className="text-[11.5px] text-faint">{s.help}</small>
            </div>
          ))}
        </div>
        <div className="overflow-x-auto border-t border-line">
          <table className="table min-w-[720px]" data-testid="detector-table">
            <thead>
              <tr>
                <th>Check</th>
                <th>What it looks for</th>
                <th className="font-mono">Fires on</th>
                <th>Precision</th>
                <th>Recall</th>
                <th className="font-mono">Weight</th>
              </tr>
            </thead>
            <tbody className={pending ? "opacity-60 transition-opacity" : ""}>
              {CHECK_ORDER.map((key) => {
                const m = result?.per_check[key];
                return (
                  <tr key={key}>
                    <td>{CHECK_TITLE[key]}</td>
                    <td className="text-muted">{CHECK_DESCRIPTION[key]}</td>
                    <td className="font-mono tabular-nums">{m?.fires_on ?? "—"}</td>
                    <td>
                      <PctBar value={m?.precision} good={0.8} />
                    </td>
                    <td>
                      <PctBar value={m?.recall} good={0.6} />
                    </td>
                    <td className="font-mono text-muted">{result?.params.weights[key] ?? "—"}</td>
                  </tr>
                );
              })}
              <tr className="bg-accent/[0.07] font-medium">
                <td>Combined score ≥ {knobs.threshold}</td>
                <td className="text-muted">What reaches the review queue</td>
                <td className="font-mono tabular-nums" data-testid="combined-flagged">
                  {result?.combined.flagged ?? "—"}
                </td>
                <td>
                  <PctBar value={result?.combined.precision} good={0.8} testId="combined-precision" />
                </td>
                <td>
                  <PctBar value={result?.combined.recall} good={0.6} />
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        <p className="px-4 py-3.5 text-[12px] text-faint">
          Precision: how often a flag is right. Recall: how many planted fakes it catches. Single checks have low recall on purpose,
          since each targets one kind of fraud; the combined score fills the queue. Ground truth exists because the data is synthetic;
          these numbers are scored against planted fraud. Outside area never fires here: every synthetic interview is inside its
          area, so it has no precision to show; it is for live phones.
        </p>
      </section>

      <section aria-label="Precision and recall by threshold" className="panel">
        <div className="ph">
          <h2>Precision and recall by review threshold</h2>
          <span className="flex items-center gap-4 text-[12px] text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded" style={{ background: COLORS.accent }} /> precision
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded" style={{ background: COLORS.ok }} /> recall
            </span>
          </span>
        </div>
        <div className="px-4 py-3.5">
          <SweepChart sweep={result?.sweep ?? []} threshold={knobs.threshold} />
        </div>
      </section>

      <HardMode />
    </div>
  );
}

const FRAUD_LABEL: Record<string, string> = {
  curbstone: "Careful curbstoner (E07)",
  copypaste: "Reworded copies (E22)",
  contradiction: "Subtle contradictions (E11)",
  speeder: "Speeder (E14)",
  night: "Night forms (E19)",
  multi_account: "Device ring",
  burst: "Burst account",
};
const AI_CHECKS: CheckKey[] = ["voice_vs_form", "copied_text"];

/** Hard mode (scripts/evaluate.py --hard): the same checks with and without the model's verdicts. */
function HardMode() {
  const [data, setData] = useState<HardEval | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    api.hardEval().then(setData, () => setMissing(true));
  }, []);
  if (missing) return null;
  const rows: { label: string; rules: number | null | undefined; ai: number | null | undefined; good: number; pct?: boolean }[] = data
    ? [
        { label: "Precision (flags that are fakes)", rules: data.rules.combined.precision, ai: data.rules_ai.combined.precision, good: 0.8, pct: true },
        { label: "Recall (fakes that are flagged)", rules: data.rules.combined.recall, ai: data.rules_ai.combined.recall, good: 0.6, pct: true },
        ...AI_CHECKS.flatMap((key) => [
          { label: `${CHECK_TITLE[key]}: catches its target fraud`, rules: data.rules.per_check[key].targeted_recall,
            ai: data.rules_ai.per_check[key].targeted_recall, good: 0.6, pct: true },
          { label: `${CHECK_TITLE[key]}: precision`, rules: data.rules.per_check[key].precision, ai: data.rules_ai.per_check[key].precision, good: 0.8, pct: true },
        ]),
      ]
    : [];
  const types = data ? Object.keys(data.planted_per_wave) : [];
  return (
    <section aria-label="Hard mode" className="panel overflow-hidden" data-testid="hard-mode">
      <div className="ph">
        <h2>Hard mode: rules only vs rules + AI</h2>
        <span className="ph-caption">
          {data ? `seeds ${data.seeds.join(", ")} · ${data.model} · ${data.calls.total.toLocaleString("en-US")} model calls` : "Loading…"}
        </span>
      </div>
      <p className="max-w-[80ch] px-4 pt-3.5 text-muted">
        Fraud written to dodge the rules: reworded copies, contradictions that mention the home pipe first, and a curbstoner who
        spreads fakes 60 to 120 m apart with 20+ minute gaps. Same checks, scored once with the rules alone and once with the
        model&apos;s verdicts as inputs. Separate seeds, never the demo wave.
      </p>
      {data && (
        <div className="grid gap-x-6 gap-y-4 p-4 lg:grid-cols-2">
          <table className="table">
            <thead>
              <tr>
                <th>Averaged over the hard waves</th>
                <th>Rules only</th>
                <th>Rules + AI</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td className="text-ink-2">{r.label}</td>
                  <td>
                    <PctBar value={r.rules} good={r.good} />
                  </td>
                  <td>
                    <PctBar value={r.ai} good={r.good} testId={r.label.startsWith("Recall") ? "hard-recall-ai" : undefined} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="table">
            <thead>
              <tr>
                <th>Missed fakes per wave</th>
                <th className="font-mono">Planted</th>
                <th>Rules only</th>
                <th>Rules + AI</th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr key={t}>
                  <td className="text-ink-2">{FRAUD_LABEL[t] ?? t}</td>
                  <td className="font-mono text-muted">{data.planted_per_wave[t]}</td>
                  <td className="font-mono">{data.rules.misses_by_fraud_type[t]}</td>
                  <td className={`font-mono ${data.rules_ai.misses_by_fraud_type[t] < data.rules.misses_by_fraud_type[t] ? "text-ok" : ""}`}>
                    {data.rules_ai.misses_by_fraud_type[t]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <div className="border-t border-line px-4 py-3 text-[12px] text-muted">
          {data.gaps.length > 0 && (
            <p className="mb-1 text-ink-2">
              What the model does not fix:{" "}
              {data.gaps.map((g) => `${FRAUD_LABEL[g.fraud_type] ?? g.fraud_type} (${g.missed} of ${g.planted} still missed)`).join("; ")}.
              {data.gaps.some((g) => g.fraud_type === "curbstone") &&
                " Meaning checks cannot see GPS and timing; a careful curbstoner needs back-checks or route plausibility (distance walked against time between interviews), not a language model."}
            </p>
          )}
          <p className="text-faint">
            {data.rules_only_run
              ? "Rules-only run: no model verdicts yet, so both columns match."
              : `${data.calls.verdicts.toLocaleString("en-US")} verdicts, ${data.calls.failed} failed calls, median ${data.calls.median_latency_ms} ms per call; model cost $${data.cost_usd.all_cached_calls.toFixed(2)}.`}{" "}
            A check&apos;s target fraud: contradictions for voice vs form; copies, bursts and the device ring for copied text.
            Scored against planted labels, aggregates only.
          </p>
        </div>
      )}
    </section>
  );
}

function SweepChart({ sweep, threshold }: { sweep: NonNullable<EvaluateResult["sweep"]>; threshold: number }) {
  const W = 640;
  const H = 220;
  const pad = { l: 36, r: 12, t: 10, b: 26 };
  const x = (t: number) => pad.l + ((t - 1) / 7) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v) * (H - pad.t - pad.b);
  const line = (key: "precision" | "recall") =>
    sweep
      .filter((s) => s[key] != null)
      .map((s, i) => `${i ? "L" : "M"}${x(s.threshold).toFixed(1)},${y(s[key]!).toFixed(1)}`)
      .join(" ");
  const at = useMemo(() => sweep.find((s) => Math.abs(s.threshold - threshold) < 1e-6), [sweep, threshold]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img"
      aria-label={at ? `At threshold ${threshold}: precision ${fmtPct(at.precision)}, recall ${fmtPct(at.recall)}` : "Precision and recall chart"}>
      {[0, 0.25, 0.5, 0.75, 1].map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.06)" />
          <text x={pad.l - 6} y={y(v) + 3.5} fill={COLORS.faint} fontSize="10" textAnchor="end">
            {v * 100}%
          </text>
        </g>
      ))}
      {[1, 2, 3, 4, 5, 6, 7, 8].map((t) => (
        <text key={t} x={x(t)} y={H - 8} fill={COLORS.faint} fontSize="10" textAnchor="middle">
          {t}
        </text>
      ))}
      <line x1={x(threshold)} x2={x(threshold)} y1={pad.t} y2={H - pad.b} stroke={COLORS.warn} strokeDasharray="3 3" />
      <path d={line("precision")} fill="none" stroke={COLORS.accent} strokeWidth="2" />
      <path d={line("recall")} fill="none" stroke={COLORS.ok} strokeWidth="2" />
      {at?.precision != null && <circle cx={x(threshold)} cy={y(at.precision)} r="4" fill={COLORS.accent} />}
      {at?.recall != null && <circle cx={x(threshold)} cy={y(at.recall)} r="4" fill={COLORS.ok} />}
      {/* Label near the axis, where the lines rarely are; flips left near the right edge. */}
      <text
        x={x(threshold) > W - 110 ? x(threshold) - 6 : x(threshold) + 6}
        y={H - pad.b - 6}
        textAnchor={x(threshold) > W - 110 ? "end" : "start"}
        fill={COLORS.warn}
        fontSize="10.5"
      >
        threshold {threshold.toFixed(1)}
      </text>
    </svg>
  );
}
