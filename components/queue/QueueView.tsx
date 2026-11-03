"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppData } from "@/components/app/AppData";
import { isTyping } from "@/components/app/AppShell";
import { useWithPasscode } from "@/components/app/Passcode";
import { useToast } from "@/components/app/Toasts";
import { EvidenceCard } from "@/components/queue/EvidenceCards";
import { Glass } from "@/components/ui/Glass";
import { api } from "@/lib/api";
import { CHECK_ORDER, CHECK_TITLE, SOURCE_LABEL, scoreClass } from "@/lib/checks";
import { DEFAULT_TZ, fmtDateTime, fmtDuration, fmtScore, fmtStamp, shortId } from "@/lib/format";
import type { Decision, QueueItem, SubmissionDetail } from "@/lib/types";

// Decision wording and colours follow the prototype.
const DECISION_LABEL: Record<Decision, string> = {
  approve: "Approved as genuine",
  backcheck: "Sent for back-check",
  reject: "Rejected as fabricated",
};
const DECISION_CLASS: Record<Decision, string> = { approve: "st-ok", backcheck: "st-info", reject: "st-crit" };
const ACTIONS: { decision: Decision; label: string; key: string; className: string }[] = [
  { decision: "approve", label: "Approve as genuine", key: "A", className: "text-ok" },
  { decision: "backcheck", label: "Send for back-check", key: "B", className: "" },
  { decision: "reject", label: "Reject as fabricated", key: "R", className: "text-crit" },
];

export function QueueView() {
  const params = useParams<{ id?: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const withPasscode = useWithPasscode();
  const { overview, map, version } = useAppData();
  const tz = overview?.project.timezone ?? DEFAULT_TZ;

  const status = search.get("status") ?? "pending";
  const band = search.get("band") ?? "flagged";
  const contributor = search.get("contributor") ?? "";
  const selectedId = params.id ?? null;
  const query = search.toString();

  const [list, setList] = useState<{ total: number; items: QueueItem[] } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  // The decision U undoes once auto-advance has moved on to the next item.
  const [lastDecision, setLastDecision] = useState<{ submissionId: string; reviewId: string } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const href = useCallback((id: string) => `/app/queue/${id}${query ? `?${query}` : ""}`, [query]);

  useEffect(() => {
    let cancelled = false;
    api.queue({ status, band, contributor: contributor || undefined }).then(
      (result) => {
        if (cancelled) return;
        setList(result);
        setListError(null);
      },
      (e: Error) => !cancelled && setListError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [status, band, contributor, version, reload]);

  // Select the first item when nothing is selected yet.
  useEffect(() => {
    if (!selectedId && list?.items.length) router.replace(href(list.items[0].submission_id), { scroll: false });
  }, [selectedId, list, router, href]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    api.submission(selectedId).then(
      (d) => !cancelled && setDetail(d),
      () => !cancelled && setDetail(null),
    );
    return () => {
      cancelled = true;
    };
  }, [selectedId, version, reload]);

  useEffect(() => {
    listRef.current?.querySelector("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
  }, [selectedId, list]);

  const items = useMemo(() => list?.items ?? [], [list]);
  const index = items.findIndex((i) => i.submission_id === selectedId);
  const current = detail && detail.submission.id === selectedId ? detail : null;
  const activeReview = current?.review && !current.review.revoked_at ? current.review : null;

  const move = useCallback(
    (step: number) => {
      if (!items.length) return;
      const next = index < 0 ? 0 : Math.min(items.length - 1, Math.max(0, index + step));
      router.replace(href(items[next].submission_id), { scroll: false });
    },
    [items, index, router, href],
  );

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`/app/queue?${next}`, { scroll: false });
  };

  const decide = useCallback(
    async (decision: Decision) => {
      if (!current || busy) return;
      if (activeReview) {
        toast({ tone: "info", title: `Already decided: ${DECISION_LABEL[activeReview.decision]}`, body: "Press U to undo first." });
        return;
      }
      // The next waiting item, decided before the list changes under us.
      const after = items.slice(index + 1).find((i) => !i.review) ?? items.slice(0, Math.max(index, 0)).find((i) => !i.review);
      setBusy(true);
      try {
        const review = await withPasscode((code) => api.review(code, current.submission.id, decision));
        if (!review) return;
        setLastDecision({ submissionId: current.submission.id, reviewId: review.id });
        toast({ tone: "ok", title: `${shortId(current.submission.id)} · ${DECISION_LABEL[decision]}`, body: "U to undo" });
        setReload((n) => n + 1);
        if (after) router.replace(href(after.submission_id), { scroll: false });
      } catch (e) {
        toast({ tone: "error", title: "Couldn't save the decision", body: e instanceof Error ? e.message : undefined });
      } finally {
        setBusy(false);
      }
    },
    [current, busy, activeReview, items, index, withPasscode, toast, router, href],
  );

  const undo = useCallback(async () => {
    if (busy) return;
    // This item's own decision first; otherwise the one just made before auto-advance.
    const own = current?.review && !current.review.revoked_at ? { submissionId: current.submission.id, reviewId: current.review.id } : null;
    const target = own ?? lastDecision;
    if (!target) {
      toast({ tone: "info", title: "Nothing to undo" });
      return;
    }
    setBusy(true);
    try {
      const undone = await withPasscode((code) => api.undoReview(code, target.reviewId));
      if (undone) {
        toast({ tone: "ok", title: `${shortId(target.submissionId)} · decision undone` });
        setLastDecision((last) => (last?.reviewId === target.reviewId ? null : last));
        setReload((n) => n + 1);
        if (target.submissionId !== current?.submission.id) router.replace(href(target.submissionId), { scroll: false });
      }
    } catch (e) {
      toast({ tone: "error", title: "Couldn't undo", body: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  }, [current, busy, lastDecision, withPasscode, toast, router, href]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector("[aria-modal='true']")) return;
      const key = event.key.toLowerCase();
      const handled =
        key === "a" ? void decide("approve")
        : key === "b" ? void decide("backcheck")
        : key === "r" ? void decide("reject")
        : key === "u" ? void undo()
        : key === "j" || key === "arrowdown" ? move(1)
        : key === "k" || key === "arrowup" ? move(-1)
        : "skip";
      if (handled !== "skip") event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, undo, move]);

  const people = useMemo(
    () => [...(overview?.contributors ?? [])].sort((a, b) => a.code.localeCompare(b.code)),
    [overview],
  );
  const fired = current ? CHECK_ORDER.map((key) => current.checks.find((c) => c.key === key && c.fired)).filter(Boolean) : [];
  const canUndo = Boolean(activeReview || lastDecision);

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      {/* Filters and list */}
      <section aria-label="Queue" className="panel overflow-hidden">
        <div className="flex flex-wrap gap-2 border-b border-line px-3 py-2.5">
          <select
            aria-label="Status filter"
            value={status}
            onChange={(e) => setFilter("status", e.target.value === "pending" ? "" : e.target.value)}
            className="input w-auto flex-1"
          >
            <option value="pending">Waiting for review</option>
            <option value="all">All</option>
            <option value="decided">Decided</option>
          </select>
          <select
            aria-label="Band filter"
            value={band}
            onChange={(e) => setFilter("band", e.target.value === "flagged" ? "" : e.target.value)}
            className="input w-auto"
          >
            <option value="flagged">Flagged</option>
            <option value="watch">Watch band</option>
          </select>
          <select
            aria-label="Contributor filter"
            value={contributor}
            onChange={(e) => setFilter("contributor", e.target.value)}
            className="input basis-full"
          >
            <option value="">All contributors</option>
            {people.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} {c.display_name}
              </option>
            ))}
          </select>
        </div>
        {listError && <p className="p-3 text-[13px] text-crit">{listError}</p>}
        <ul
          ref={listRef}
          className="scrollbar-thin max-h-[calc(100vh-220px)] min-h-[200px] overflow-y-auto p-1"
          role="listbox"
          aria-label="Submissions"
        >
          {items.map((item) => {
            const selected = item.submission_id === selectedId;
            const review = item.review && !item.review.revoked_at ? item.review : null;
            return (
              <li key={item.submission_id} role="option" aria-selected={selected}>
                <Link
                  href={href(item.submission_id)}
                  scroll={false}
                  className={`flex flex-col gap-[5px] rounded-[7px] px-2.5 py-[9px] ${
                    selected ? "bg-overlay/[0.06] shadow-[inset_2px_0_0_var(--color-accent)]" : "hover:bg-hover"
                  } ${review && !selected ? "opacity-50" : ""}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">
                      <span className="font-mono">{shortId(item.submission_id)}</span>{" "}
                      {item.source === "live" && (
                        <span className="live-tag" title="Sent from a phone on /collect">Live · phone</span>
                      )}{" "}
                      <span className="text-muted">
                        {item.contributor.code} · {fmtStamp(item.captured_at, tz)}
                      </span>
                    </span>
                    <span className="flex flex-none items-center gap-1.5">
                      {item.ai_pending && (
                        <span className="ai-spinner" role="status" aria-label="A model is still checking this one" title="A model is still checking this one" />
                      )}
                      <span className={scoreClass(item.score, item.band)}>{fmtScore(item.score)}</span>
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {item.fired.map((key) => (
                      <span key={key} className="chip">
                        {CHECK_TITLE[key]}
                      </span>
                    ))}
                    {review && (
                      <span className={`st ${DECISION_CLASS[review.decision]}`}>
                        <span>{DECISION_LABEL[review.decision]}</span>
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
          {list && !items.length && <li className="px-2.5 py-3 text-muted">Nothing here. Change the filter.</li>}
          {!list && !listError && <li className="px-2.5 py-3 text-muted">Loading…</li>}
        </ul>
      </section>

      {/* Evidence */}
      <section aria-label="Evidence" className="panel min-w-0">
        {!current ? (
          <div className="px-4 py-3.5 text-muted">{selectedId ? "Loading the evidence…" : "The queue is clear."}</div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 px-[18px] pt-4">
              <h2 className="font-mono text-[18px] font-medium tracking-normal">{shortId(current.submission.id)}</h2>
              <span className="flex items-center gap-2">
                {current.submission.source === "live" && (
                  <span className="st st-info">
                    <span>Live</span>
                  </span>
                )}
                Score{" "}
                {current.score && (
                  <span className={scoreClass(current.score.score, current.score.band)}>{fmtScore(current.score.score)}</span>
                )}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-[18px] gap-y-1.5 border-b border-line px-[18px] pt-1.5 pb-4 text-[12px] text-muted">
              <span>
                {current.contributor.kind === "enumerator" ? "Enumerator" : "Participant"}{" "}
                <b className="font-medium text-ink">
                  {current.contributor.code} {current.contributor.display_name}
                </b>
              </span>
              <span>
                Area <b className="font-medium text-ink">{current.contributor.area}</b>
              </span>
              <span>
                Captured <b className="font-medium text-ink">{fmtStamp(current.submission.captured_at, tz)}</b>
              </span>
              <span>
                Duration <b className="font-medium text-ink">{fmtDuration(current.submission.duration_sec)}</b>
              </span>
            </div>

            <div className="border-b border-line px-[18px] py-4">
              <h3 className="mb-2.5 font-sans text-[12px] font-medium tracking-normal text-faint">Why it was flagged</h3>
              <div className="grid gap-2.5">
                {fired.length === 0 && <p className="text-muted">No checks fired on this submission.</p>}
                {fired.map((check) => (
                  <EvidenceCard key={check!.key} check={check!} detail={current} map={map} tz={tz} />
                ))}
              </div>
            </div>

            <RawSubmission detail={current} tz={tz} />
          </>
        )}

        <Glass className="sticky bottom-3 z-[3] mx-3 mb-3 flex flex-wrap items-center gap-2 rounded-xl px-[18px] py-3.5">
          {activeReview ? (
            <span className={`st ${DECISION_CLASS[activeReview.decision]}`}>
              <span>{DECISION_LABEL[activeReview.decision]}</span>
            </span>
          ) : (
            ACTIONS.map((a) => (
              <button
                key={a.decision}
                type="button"
                disabled={!current || busy}
                onClick={() => void decide(a.decision)}
                className="btn"
              >
                <span className={a.className}>{a.label}</span>
                <kbd className="kbd">{a.key}</kbd>
              </button>
            ))
          )}
          {canUndo && (
            <button type="button" disabled={busy} onClick={() => void undo()} className="btn btn-sm">
              Undo{!activeReview && lastDecision ? ` ${shortId(lastDecision.submissionId)}` : ""} <kbd className="kbd">U</kbd>
            </button>
          )}
          <span className="ml-auto hidden items-center gap-1.5 text-[11.5px] text-faint sm:flex">
            <kbd className="kbd">J</kbd>
            <kbd className="kbd">K</kbd> move · {index >= 0 ? `${index + 1} of ${items.length}` : `${items.length} in list`}
          </span>
        </Glass>
      </section>
    </div>
  );
}

function RawSubmission({ detail, tz }: { detail: SubmissionDetail; tz: string }) {
  const s = detail.submission;
  const delay = (new Date(s.synced_at).getTime() - new Date(s.captured_at).getTime()) / 1000;
  return (
    <div className="px-[18px] py-4" aria-label="Raw submission">
      <h3 className="mb-2.5 font-sans text-[12px] font-medium tracking-normal text-faint">Submission</h3>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-[12.5px] sm:grid-cols-[150px_1fr] [&_dd]:text-ink-2 [&_dt]:text-faint">
        <dt>Water source</dt>
        <dd>{SOURCE_LABEL[s.answers.water_source ?? ""] ?? s.answers.water_source}</dd>
        <dt>Voice note</dt>
        <dd>{s.voice_transcript ? `"${s.voice_transcript}"` : "—"}</dd>
        <dt>Biggest challenge</dt>
        <dd>{s.answers.open_text}</dd>
        <dt>Satisfaction (1 to 5)</dt>
        <dd>
          <div className="likert">
            {(s.answers.satisfaction ?? []).map((v, i) => (
              <span key={i}>{v}</span>
            ))}
          </div>
        </dd>
        <dt>Captured</dt>
        <dd>{fmtDateTime(s.captured_at, tz)}</dd>
        <dt>Synced</dt>
        <dd>
          {fmtDateTime(s.synced_at, tz)} <span className="text-faint">({fmtDuration(Math.max(0, delay))} later)</span>
        </dd>
        <dt>GPS</dt>
        <dd className="font-mono text-[12px]">
          {s.lat?.toFixed(5)}, {s.lng?.toFixed(5)} <span className="text-faint">± {s.gps_accuracy_m ?? "?"} m</span>
        </dd>
        <dt>Device</dt>
        <dd className="font-mono text-[12px]">{s.device_id}</dd>
        <dt>Source</dt>
        <dd>{s.source}</dd>
      </dl>
    </div>
  );
}
