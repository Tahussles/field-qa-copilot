"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Section } from "@/components/ui/Disclosure";
import { Tip } from "@/components/ui/Tip";
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
      <span className="min-w-10 font-mono tabular-nums" data-testid={testId}>
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
      <Section
        title={
          <Tip
            content={`Scored against the planted fakes in the synthetic wave (${result ? `${result.combined.fabricated} among ${result.combined.submissions.toLocaleString("en-US")}` : "…"}); these numbers are scored against planted fraud, and nothing here changes the live queue.`}
            className="cursor-help underline decoration-dotted underline-offset-4"
          >
            Tune
          </Tip>
        }
        aria-label="Tune the detectors"
        actions={
          <button type="button" disabled={!changed} onClick={() => setKnobs(DEFAULTS)} className="btn btn-sm btn-ghost">
            Reset
          </button>
        }
        bodyClassName="flex flex-col gap-4 p-4"
      >
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          {SLIDERS.map((s) => (
            <div key={s.key}>
              <div className="mb-1.5 flex justify-between text-[13px] font-medium">
                <label htmlFor={`slider-${s.key}`} title={s.help}>
                  {s.label}
                </label>
                <span className="font-mono text-accent-ink" data-testid={`value-${s.key}`}>
                  {s.format(knobs[s.key])}
                </span>
              </div>
              <input
                id={`slider-${s.key}`}
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={knobs[s.key]}
                onChange={(e) => setKnobs((k) => ({ ...k, [s.key]: Number(e.target.value) }))}
                className="w-full accent-accent"
                aria-describedby={`help-${s.key}`}
              />
              <span id={`help-${s.key}`} hidden>
                {s.help}
              </span>
            </div>
          ))}
        </div>
        {/* The combined result: what reaches the review queue at this threshold. */}
        <div
          className={`grid grid-cols-3 gap-px overflow-hidden rounded-[10px] border border-line-strong bg-line-strong ${pending ? "opacity-60 transition-opacity" : ""}`}
          data-testid="combined"
        >
          {[
            { label: "flagged", value: <span data-testid="combined-flagged">{result?.combined.flagged ?? "—"}</span> },
            {
              label: (
                <Tip content="How often a flag is a planted fake." className="cursor-help underline decoration-dotted underline-offset-2">
                  precision
                </Tip>
              ),
              value: <PctBar value={result?.combined.precision} good={0.8} testId="combined-precision" />,
            },
            {
              label: (
                <Tip content="How many planted fakes are flagged. Single checks have low recall on purpose: each targets one kind of fraud, and the combined score fills the queue." className="cursor-help underline decoration-dotted underline-offset-2">
                  recall
                </Tip>
              ),
              value: <PctBar value={result?.combined.recall} good={0.6} testId="combined-recall" />,
            },
          ].map((c, i) => (
            <div key={i} className="bg-panel px-4 py-3">
              <div className="font-mono text-[20px] font-medium tabular-nums">{c.value}</div>
              <div className="text-[12px] text-muted">{c.label}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="By threshold"
        aria-label="Precision and recall by threshold"
        actions={
          <span className="flex items-center gap-4 text-[12px] text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded" style={{ background: COLORS.accent }} /> precision
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded" style={{ background: COLORS.ok }} /> recall
            </span>
          </span>
        }
      >
        <SweepChart sweep={result?.sweep ?? []} threshold={knobs.threshold} />
      </Section>

      <Section
        title="Per-check breakdown"
        aria-label="Per-check breakdown"
        summary={result ? `${CHECK_ORDER.filter((k) => (result.per_check[k]?.fires_on ?? 0) > 0).length}/${CHECK_ORDER.length} fire` : null}
        collapsible
        defaultOpen={false}
        storeKey="detectors-breakdown"
        bodyClassName=""
        data-testid="per-check"
      >
        <div className="overflow-x-auto">
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
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-4 py-3 text-[12px] text-faint">
          Outside area and clock skew never fire here: synthetic interviews stay inside their areas and carry no phone clock; they are
          for live phones.
        </p>
      </Section>

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
    <Section
      title="Hard mode"
      aria-label="Hard mode"
      summary={data ? `recall ${fmtPct(data.rules.combined.recall)} → ${fmtPct(data.rules_ai.combined.recall)}` : "…"}
      collapsible
      defaultOpen={false}
      storeKey="detectors-hard"
      bodyClassName=""
      data-testid="hard-mode"
    >
      <p className="max-w-[80ch] px-4 pt-3.5 text-muted">
        Fraud written to dodge the rules (reworded copies, subtle contradictions, a careful curbstoner), scored with the rules alone and
        with the model&apos;s verdicts as inputs, on separate seeds.
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
              : `${data.calls.verdicts.toLocaleString("en-US")} verdicts from ${data.model}, ${data.calls.failed} failed calls, median ${data.calls.median_latency_ms} ms per call; model cost $${data.cost_usd.all_cached_calls.toFixed(2)}.`}{" "}
            A check&apos;s target fraud: contradictions for voice vs form; copies, bursts and the device ring for copied text.
          </p>
        </div>
      )}
    </Section>
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
    <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto h-auto w-full max-w-[860px]" role="img"
      aria-label={at ? `At threshold ${threshold}: precision ${fmtPct(at.precision)}, recall ${fmtPct(at.recall)}` : "Precision and recall chart"}>
      {[0, 0.25, 0.5, 0.75, 1].map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="stroke-contrast/[0.06]" />
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
