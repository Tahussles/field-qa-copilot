"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Glass } from "@/components/ui/Glass";
import { MethodChip } from "@/components/ui/Tip";
import { api } from "@/lib/api";
import { CHECK_TITLE, scoreClass } from "@/lib/checks";
import type { OutboxItem } from "@/lib/collect/outbox";
import { fmtScore, fmtStamp, fmtTime, shortId } from "@/lib/format";
import { browserSupabase } from "@/lib/supabase";
import type { SubmissionDetail } from "@/lib/types";

const LANGUAGE: Record<string, string> = { en: "English", sw: "Swahili", luo: "Dholuo" };
type Job = { kind: string; status: string; model: string | null; latency_ms: number | null; created_at: string };
// A model job still queued or running after this long has stalled: the rules' result stands, no spinner.
const STALLED_MS = 60_000;
const POLL_MS = 3000; // while the Realtime socket is down
// The phone's own time zone. During a demo the server puts the interview on the field clock
// (Kisumu, from the pinned morning), so the screen shows both.
const PHONE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const place = (zone: string) => zone.split("/").pop()?.replace(/_/g, " ") ?? zone;

/**
 * One phone submission, live: the rules' result at once, then the model's work as it
 * lands (Realtime events for this submission, each followed by a fresh read).
 */
export function ResultScreen({ item, tz, onNew }: { item: OutboxItem; tz: string; onNew: () => void }) {
  const id = item.result?.id ?? null;
  const rules = item.result;
  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [shownAt] = useState(() => Date.now()); // the server's clock is not the phone's: measure from here

  const refresh = useCallback(async () => {
    if (!id) return;
    const supabase = browserSupabase();
    const [d, j] = await Promise.all([
      api.submission(id).catch(() => null),
      supabase?.from("ai_jobs").select("kind,status,model,latency_ms,created_at").eq("submission_id", id),
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
    let poll: number | null = null;
    let disposed = false;
    const channel = supabase
      .channel(`collect-${id}`)
      .on("postgres_changes", on("ai_jobs", `submission_id=eq.${id}`), () => void refresh())
      .on("postgres_changes", on("ai_verdicts", `submission_id=eq.${id}`), () => void refresh())
      .on("postgres_changes", on("scores", `submission_id=eq.${id}`), () => void refresh())
      .on("postgres_changes", on("submissions", `id=eq.${id}`), () => void refresh())
      .subscribe((status) => {
        if (disposed) return;
        if (status === "SUBSCRIBED") {
          if (poll) void refresh();
          if (poll) window.clearInterval(poll);
          poll = null;
          setReconnecting(false);
        } else {
          setReconnecting(true);
          if (!poll) poll = window.setInterval(() => void refresh(), POLL_MS);
        }
      });
    return () => {
      disposed = true;
      if (poll) window.clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [id, refresh]);

  const transcribe = jobs.find((j) => j.kind === "transcribe");
  const consistency = jobs.find((j) => j.kind === "consistency");
  const transcript = detail?.submission.voice_transcript ?? null;
  const stalled = (j?: Job) =>
    Boolean(j && (j.status === "queued" || j.status === "running") && now - Date.parse(j.created_at) > STALLED_MS);
  const busy = (j?: Job) => Boolean(j && (j.status === "queued" || j.status === "running") && !stalled(j));
  const unavailable = (j?: Job) => Boolean(j && (j.status === "failed" || j.status === "skipped" || stalled(j)));
  // The check job is queued when the transcript lands; if it never appears, the model is not coming.
  const checkMissing = Boolean(transcript && !consistency && transcribe && now - Date.parse(transcribe.created_at) > STALLED_MS);
  const vff = detail?.checks.find((c) => c.key === "voice_vs_form");
  const decidedByAi = vff?.evidence.decided_by === "ai";
  const noTranscript = unavailable(transcribe) || (!transcribe && Boolean(rules) && now - shownAt > STALLED_MS);
  const noCheck = unavailable(consistency) || checkMissing;
  const pending = Boolean(item.audio) && !(transcript ? !busy(consistency) && (consistency || noCheck) : noTranscript);
  const current = detail?.score ?? null;

  // While model work is pending, re-check every few seconds whether it has stalled.
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [pending]);

  return (
    <div className="flex flex-col gap-3" data-testid="result">
      <Glass className="glass-tint rounded-xl p-4">
        <p className="text-[12px] text-muted" data-testid="clocks">
          {shortId(item.client_submission_id.replace(/^phone-/, ""))} · phone{" "}
          <span className="font-mono text-ink-2">{fmtStamp(item.saved_at, PHONE_TZ)}</span> {place(PHONE_TZ)}
          {rules ? (
            <>
              {" "}
              · field <span className="font-mono text-ink-2" data-testid="field-time">{fmtStamp(rules.captured_at, tz)}</span> Kisumu
            </>
          ) : null}
          {item.synced_at ? (
            <>
              {" "}
              · synced <span className="font-mono text-ink-2" data-testid="synced-at">{fmtTime(item.synced_at, PHONE_TZ)}</span>
            </>
          ) : null}
        </p>
        {reconnecting && (
          <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-[11.5px] text-muted" role="status" data-testid="reconnecting">
            <span className="ai-spinner" aria-hidden /> Reconnecting… updating every 3 s
          </p>
        )}
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
        <Stage n={2} title="Voice note" done={Boolean(transcript)} busy={!transcript && !noTranscript}>
          {transcript ? (
            <p data-testid="transcript">
              <span className="text-[12px] text-muted">
                {LANGUAGE[detail?.submission.transcript_lang ?? ""] ?? detail?.submission.transcript_lang ?? "language unknown"}
                {transcribe?.latency_ms ? ` · ${transcribe.model} · ${transcribe.latency_ms} ms` : ""}
              </span>
              <br />“{transcript}”
            </p>
          ) : noTranscript ? (
            <p className="text-muted" data-testid="ai-unavailable">Checked by rules (AI unavailable): no transcript, the rules&apos; result stands.</p>
          ) : (
            <p className="text-muted" data-testid="transcribing">Transcribing…</p>
          )}
        </Stage>
      )}

      {rules && item.audio && !transcript && (
        <Stage n={3} title="Voice against the form">
          <p className="text-muted">{noTranscript ? "Checked by rules (AI unavailable)." : "Waits for the transcript."}</p>
        </Stage>
      )}

      {rules && transcript && (
        <Stage n={3} title="Voice against the form" done={!busy(consistency) && (Boolean(consistency) || noCheck)} busy={busy(consistency) || (!consistency && !noCheck)}>
          {decidedByAi && vff ? (
            <Verdict transcript={transcript} evidence={vff.evidence} fired={vff.fired} />
          ) : noCheck ? (
            <p className="text-muted" data-testid="ai-unavailable">
              Checked by rules (AI unavailable): the keyword rule found {vff?.fired ? "a contradiction" : "no contradiction"}.
            </p>
          ) : busy(consistency) || !consistency ? (
            <p className="text-muted" data-testid="checking">Checking voice against the form…</p>
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
  if (f.key === "outside_area" && f.evidence.distance) return `${title} (${f.evidence.distance} from ${f.evidence.area})`;
  if (f.key === "clock_skew") {
    const minutes = Math.abs(Number(f.evidence.skew_minutes));
    return `${title} (${minutes >= 90 ? `${(minutes / 60).toFixed(1)} h` : `${Math.round(minutes)} min`} ${f.evidence.direction})`;
  }
  return title;
}

function Stage({ n, title, done, busy, children }: { n: number; title: string; done?: boolean; busy?: boolean; children: React.ReactNode }) {
  return (
    <Glass as="section" className="rounded-xl p-4" aria-label={title} aria-busy={busy}>
      <h2 className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold">
        <span className={`flex h-5 w-5 items-center justify-center rounded-full font-mono text-[11px] ${done ? "bg-ok/20 text-ok" : "bg-contrast/10 text-muted"}`}>
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
      <p className="flex flex-wrap items-center gap-x-1.5">
        <MethodChip ai tip={`Decided by ${String(evidence.model ?? "the model")}${evidence.latency_ms ? ` in ${evidence.latency_ms} ms` : ""}; the quote is an exact span of the transcript.`} />
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
    </div>
  );
}
