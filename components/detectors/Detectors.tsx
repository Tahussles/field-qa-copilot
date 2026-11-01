"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";
import { CHECK_LABEL, CHECK_ORDER, COLORS } from "@/lib/checks";
import { fmtPct } from "@/lib/format";
import type { EvaluateResult } from "@/lib/types";

interface Knobs {
  tooFastMin: number;
  radius: number;
  similarity: number;
  threshold: number;
}

const DEFAULTS: Knobs = { tooFastMin: 12, radius: 50, similarity: 0.8, threshold: 2 };

const SLIDERS: { key: keyof Knobs; label: string; min: number; max: number; step: number; format: (v: number) => string; help: string }[] = [
  { key: "tooFastMin", label: "Too fast (enumerators)", min: 4, max: 24, step: 1, format: (v) => `${v} min`, help: "Interviews shorter than this fire too_fast." },
  { key: "radius", label: "Same spot radius", min: 10, max: 200, step: 5, format: (v) => `${v} m`, help: "Interviews this close on one day count as the same spot." },
  { key: "similarity", label: "Copied text similarity", min: 0.5, max: 1, step: 0.05, format: (v) => v.toFixed(2), help: "Word overlap needed to call two answers copies." },
  { key: "threshold", label: "Review threshold", min: 1, max: 8, step: 0.5, format: (v) => v.toFixed(1), help: "Scores at or above this go to the review queue." },
];

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
    <div className="mx-auto grid max-w-[1400px] gap-3 lg:grid-cols-[340px_minmax(0,1fr)]">
      <section aria-label="Detector settings" className="panel space-y-5 p-4">
        <div className="flex items-center">
          <h2 className="font-display text-sm font-semibold">Settings</h2>
          <button
            type="button"
            disabled={!changed}
            onClick={() => setKnobs(DEFAULTS)}
            className="ml-auto text-[12px] text-muted hover:text-ink disabled:opacity-40"
          >
            Reset to defaults
          </button>
        </div>
        {SLIDERS.map((s) => (
          <div key={s.key}>
            <div className="flex items-baseline justify-between">
              <label htmlFor={`slider-${s.key}`} className="text-[13px] text-ink-2">
                {s.label}
              </label>
              <span className="font-mono text-[12.5px] text-ink" data-testid={`value-${s.key}`}>
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
              className="mt-2 w-full accent-[#7c84f8]"
            />
            <p className="mt-1 text-[11.5px] text-faint">{s.help}</p>
          </div>
        ))}
        <p className="border-t border-line pt-3 text-[11.5px] text-faint">
          Changes here are a what-if: nothing is saved and the live queue keeps its settings.
        </p>
      </section>

      <div className="flex min-w-0 flex-col gap-3">
        {error && <p className="panel p-3 text-[13px] text-crit">{error}</p>}
        <section aria-label="Detector performance" className="panel overflow-hidden" aria-busy={pending}>
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <h2 className="font-display text-sm font-semibold">How each check performs</h2>
            <span className="text-[12px] text-faint">
              {result ? `${result.combined.submissions} synthetic submissions, ${result.combined.fabricated} planted fakes` : "Scoring…"}
            </span>
            {pending && <span className="ml-auto text-[11.5px] text-muted">Updating…</span>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[13px]" data-testid="detector-table">
              <thead className="text-[11.5px] text-faint">
                <tr>
                  <th className="py-2 pr-2 pl-4 font-normal">Check</th>
                  <th className="px-2 text-right font-normal">Weight</th>
                  <th className="px-2 text-right font-normal">Fires on</th>
                  <th className="px-2 text-right font-normal">Precision</th>
                  <th className="py-2 pr-4 pl-2 text-right font-normal">Recall</th>
                </tr>
              </thead>
              <tbody className={pending ? "opacity-60 transition-opacity" : ""}>
                {CHECK_ORDER.map((key) => {
                  const m = result?.per_check[key];
                  return (
                    <tr key={key} className="border-t border-line">
                      <td className="py-2 pr-2 pl-4 text-ink-2">{CHECK_LABEL[key]}</td>
                      <td className="px-2 text-right font-mono text-[12px] text-muted">{result?.params.weights[key] ?? "—"}</td>
                      <td className="px-2 text-right tabular-nums text-ink-2">{m?.fires_on ?? "—"}</td>
                      <td className="px-2 text-right tabular-nums text-ink-2">{fmtPct(m?.precision, 1)}</td>
                      <td className="py-2 pr-4 pl-2 text-right tabular-nums text-ink-2">{fmtPct(m?.recall, 1)}</td>
                    </tr>
                  );
                })}
                <tr className="border-t border-line-strong bg-white/[0.025] font-medium">
                  <td className="py-2.5 pr-2 pl-4 text-ink">Combined at {knobs.threshold.toFixed(1)}</td>
                  <td className="px-2" />
                  <td className="px-2 text-right tabular-nums text-ink" data-testid="combined-flagged">
                    {result?.combined.flagged ?? "—"}
                  </td>
                  <td className="px-2 text-right tabular-nums text-accent" data-testid="combined-precision">
                    {fmtPct(result?.combined.precision, 1)}
                  </td>
                  <td className="py-2.5 pr-4 pl-2 text-right tabular-nums text-ok">{fmtPct(result?.combined.recall, 1)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section aria-label="Precision and recall by threshold" className="panel p-4">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <h2 className="font-display text-sm font-semibold">Precision and recall by review threshold</h2>
            <span className="flex items-center gap-1.5 text-[12px] text-muted">
              <span className="h-0.5 w-4 rounded" style={{ background: COLORS.accent }} /> precision
            </span>
            <span className="flex items-center gap-1.5 text-[12px] text-muted">
              <span className="h-0.5 w-4 rounded" style={{ background: COLORS.ok }} /> recall
            </span>
          </div>
          <SweepChart sweep={result?.sweep ?? []} threshold={knobs.threshold} />
          <p className="mt-3 text-[12px] text-faint">
            Ground truth exists because the data is synthetic; these numbers are scored against planted fraud.
          </p>
        </section>
      </div>
    </div>
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
