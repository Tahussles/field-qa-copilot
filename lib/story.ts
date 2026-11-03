"use client";

// The numbers /architecture and /pitch show. Every one comes from /api/py/story, which serves the
// generated files (data/eval/headline.json, hard.json, measurements.json) and the spend right now.

import { useEffect, useState } from "react";

type Combined = { precision: number; recall: number; flagged: number };

export interface Story {
  headline: {
    engine_version: string;
    review_threshold: number;
    held_out_seeds: number[];
    held_out: Combined & { fabricated: number; false_positives: number; precision_range: number[]; recall_range: number[] };
    demo_seed: Combined & { submissions: number; fabricated: number };
  } | null;
  hard: {
    seeds: number[];
    rules: { combined: Combined };
    rules_ai: { combined: Combined };
    clock_skew?: { without: { night_missed: number }; with: { night_missed: number } };
    calls: { verdicts: number };
    cost_usd: { all_cached_calls: number };
  } | null;
  measured: {
    measured_at: string;
    ingest: { n: number; p50_ms: number; p95_ms: number; api_p50_ms: number };
    phone: { n: number; rules_s: number; transcript_s: number; verdict_s: number };
    realtime?: { p50_ms: number; n: number };
    model_latency: Record<string, { p50_ms: number; p95_ms: number; n: number }>;
    spend: { usd: number; jobs: number };
  } | null;
  spend_now: { all_time_usd: number; all_time_jobs: number } | null;
}

export function useStory(): { story: Story | null; error: string | null } {
  const [story, setStory] = useState<Story | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/py/story")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setStory)
      .catch((e: Error) => setError(e.message));
  }, []);
  return { story, error };
}

export const pct = (v: number | undefined | null, digits = 1) => (v == null ? "…" : `${(v * 100).toFixed(digits)}%`);
export const secs = (v: number | undefined | null) => (v == null ? "…" : `${v.toFixed(1)} s`);
export const msec = (v: number | undefined | null) => (v == null ? "…" : `${Math.round(v)} ms`);
export const usd = (v: number | undefined | null) => (v == null ? "…" : `$${v.toFixed(2)}`);
