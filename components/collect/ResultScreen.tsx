"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Glass } from "@/components/ui/Glass";
import { api } from "@/lib/api";
import { CHECK_TITLE, scoreClass } from "@/lib/checks";
import type { OutboxItem } from "@/lib/collect/outbox";
import { fmtScore, fmtStamp, shortId } from "@/lib/format";
import { browserSupabase } from "@/lib/supabase";
import type { SubmissionDetail } from "@/lib/types";

const LANGUAGE: Record<string, string> = { en: "English", sw: "Swahili", luo: "Dholuo" };
type Job = { kind: string; status: string; model: string | null; latency_ms: number | null };

/**
 * One phone submission, live: the rules' result at once, then the model's work as it
 * lands (Realtime events for this submission, each followed by a fresh read).
 */
export function ResultScreen({ item, tz, onNew }: { item: OutboxItem; tz: string; onNew: () => void }) {
  const id = item.result?.id ?? null;
  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);

  const refresh = useCallback(async () => {
    if (!id) return;
    const supabase = browserSupabase();
    const [d, j] = await Promise.all([
      api.submission(id).catch(() => null),
      supabase?.from("ai_jobs").select("kind,status,model,latency_ms").eq("submission_id", id),
    ]);
    if (d) setDetail(d);
    if (j?.data) setJobs(j.data as Job[]);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    queueMicrotask(() => void refresh());
    const supabase = browserSupabase();
    if (!supabase) return;
    const on = (table: string, filter: string) => ({ event: "*" as const, schema: "public", table, filter });
    const channel = supabase
      .channel(`collect-${id}`)
      .on("postgres_changes", on("ai_jobs", `submission_id=eq.${id}`), () => void refresh())
      .on("postgres_changes", on("ai_verdicts", `submission_id=eq.${id}`), () => void refresh())
      .on("postgres_changes", on("scores", `submission_id=eq.${id}`), () => void refresh())
      .on("postgres_changes", on("submissions", `id=eq.${id}`), () => void refresh())
      .subscribe();
    return () => void supabase.removeChannel(channel);
  }, [id, refresh]);

  const rules = item.result;
  const transcribe = jobs.find((j) => j.kind === "transcribe");
  const consistency = jobs.find((j) => j.kind === "consistency");
  const busy = (j?: Job) => j && (j.status === "queued" || j.status === "running");
  const transcript = detail?.submission.voice_transcript ?? null;
  const vff = detail?.checks.find((c) => c.key === "voice_vs_form");
  const decidedByAi = vff?.evidence.decided_by === "ai";
  const pending = busy(transcribe) || busy(consistency) || (item.audio && !transcript && transcribe?.status !== "failed");
  const current = detail?.score ?? null;

  return (
    <div className="flex flex-col gap-3" data-testid="result">
      <Glass className="glass-tint rounded-xl p-4">
        <p className="text-[12px] text-muted">
          {shortId(item.client_submission_id.replace(/^phone-/, ""))} · captured{" "}
          <span className="font-mono text-ink-2">{fmtStamp(item.saved_at, tz)}</span>
          {item.synced_at ? (
            <>
              {" "}
              · synced <span className="font-mono text-ink-2" data-testid="synced-at">{fmtStamp(item.synced_at, tz)}</span>
            </>
          ) : null}
        </p>
        {item.status !== "synced" ? (
          <p className="mt-2 flex items-center gap-2 text-ink" data-testid="waiting">
            <span className="ai-spinner" aria-hidden />
            {item.status === "error" ? `Not sent: ${item.error}` : "Saved on this phone · will sync"}
          </p>
        ) : null}
      </Glass>

      {rules && (
        <Stage n={1} title="Rules result" done>
          <p className="flex items-center gap-2">
            Score <span className={scoreClass(rules.score ?? 0, rules.band ?? "clear")}>{fmtScore(rules.score)}</span>
            <BandTag band={rules.band} />
          </p>
          <p className="mt-1 text-[12.5px] text-muted">
            {rules.fired.length ? rules.fired.map(firedLabel).join(" · ") : "No check fired on arrival"}
          </p>
        </Stage>
      )}

      {rules && item.audio && (
        <Stage n={2} title="Voice note" done={Boolean(transcript)} busy={!transcript && transcribe?.status !== "failed"}>
          {transcript ? (
            <p data-testid="transcript">
              <span className="text-[12px] text-muted">
                {LANGUAGE[detail?.submission.transcript_lang ?? ""] ?? detail?.submission.transcript_lang ?? "language unknown"}
                {transcribe?.latency_ms ? ` · ${transcribe.model} · ${transcribe.latency_ms} ms` : ""}
              </span>
              <br />“{transcript}”
            </p>
          ) : transcribe?.status === "failed" || transcribe?.status === "skipped" ? (
            <p className="text-muted">Transcription unavailable here; the rules stand.</p>
          ) : (
            <p className="text-muted" data-testid="transcribing">Transcribing…</p>
          )}
        </Stage>
      )}

      {rules && item.audio && !transcript && (
        <Stage n={3} title="Voice against the form">
          <p className="text-muted">
            {transcribe?.status === "failed" || transcribe?.status === "skipped" ? "No transcript, so nothing to check." : "Waits for the transcript."}
          </p>
        </Stage>
      )}

      {rules && transcript && (
        <Stage n={3} title="Voice against the form" done={!busy(consistency)} busy={busy(consistency)}>
          {busy(consistency) || !consistency ? (
            <p className="text-muted" data-testid="checking">Checking voice against the form…</p>
          ) : decidedByAi && vff ? (
            <Verdict transcript={transcript} evidence={vff.evidence} fired={vff.fired} />
          ) : (
            <p className="text-muted">Decided by the keyword rule ({vff?.fired ? "contradiction" : "no contradiction"}).</p>
          )}
        </Stage>
      )}

      {rules && current && (
        <Stage n={item.audio ? 4 : 2} title={pending ? "Score so far" : "Final score"} done={!pending}>
          <p className="flex items-center gap-2" data-testid="final">
            Score <span className={scoreClass(current.score, current.band)}>{fmtScore(current.score)}</span>
            <BandTag band={current.band} />
            {rules.score !== current.score && <span className="text-[12px] text-muted">(was {fmtScore(rules.score)} on arrival)</span>}
          </p>
          <p className="mt-1 text-[12.5px] text-muted">
            {(detail?.checks ?? []).filter((c) => c.fired).map((c) => CHECK_TITLE[c.key]).join(" · ") || "No check fired"}
          </p>
        </Stage>
      )}

      <div className="flex flex-wrap gap-2">
        {id && (
          <Link href={`/app/queue/${id}?status=all`} className="btn" target="_blank">
            Open in the review queue
          </Link>
        )}
        <button type="button" onClick={onNew} className="btn btn-primary">
          New interview
        </button>
      </div>
    </div>
  );
}

// The one check whose evidence a field worker can act on at once: how far out they are.
function firedLabel(f: { key: string; evidence: Record<string, unknown> }) {
  const title = CHECK_TITLE[f.key as keyof typeof CHECK_TITLE];
  return f.key === "outside_area" && f.evidence.distance ? `${title} (${f.evidence.distance} from ${f.evidence.area})` : title;
}

function Stage({ n, title, done, busy, children }: { n: number; title: string; done?: boolean; busy?: boolean; children: React.ReactNode }) {
  return (
    <Glass as="section" className="rounded-xl p-4" aria-label={title} aria-busy={busy}>
      <h2 className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold">
        <span className={`flex h-5 w-5 items-center justify-center rounded-full font-mono text-[11px] ${done ? "bg-ok/20 text-ok" : "bg-white/10 text-muted"}`}>
          {done ? "✓" : n}
        </span>
        {title}
        {busy && <span className="ai-spinner ml-auto" aria-hidden />}
      </h2>
      <div className="text-[13.5px] text-ink-2">{children}</div>
    </Glass>
  );
}

function BandTag({ band }: { band: string | null | undefined }) {
  const cls = band === "flagged" ? "st-crit" : band === "watch" ? "st-warn" : "st-ok";
  const label = band === "flagged" ? "Flagged for review" : band === "watch" ? "Watch" : "Passed";
  return (
    <span className={`st ${cls}`} data-testid="band">
      <span>{label}</span>
    </span>
  );
}

function Verdict({ transcript, evidence, fired }: { transcript: string; evidence: Record<string, unknown>; fired: boolean }) {
  const quote = String(evidence.quote ?? "");
  const at = quote ? transcript.indexOf(quote) : -1;
  return (
    <div data-testid="verdict">
      <p>
        <span className="ai-tag ml-0 mr-1.5">AI</span>
        {fired ? <b className="text-crit">Contradiction</b> : <b className="text-ok">No contradiction</b>} · confidence{" "}
        {Math.round(Number(evidence.confidence) * 100)}%
      </p>
      {at >= 0 && (
        <p className="mt-1.5 text-[13px]">
          {transcript.slice(0, at)}
          <mark data-testid="quote">{transcript.slice(at, at + quote.length)}</mark>
          {transcript.slice(at + quote.length)}
        </p>
      )}
      <p className="mt-1.5 text-[12.5px] text-muted">{String(evidence.explanation ?? "")}</p>
      <p className="mt-1 text-[11.5px] text-faint">
        {String(evidence.model ?? "")}
        {evidence.latency_ms ? ` · ${evidence.latency_ms} ms` : ""}
      </p>
    </div>
  );
}
