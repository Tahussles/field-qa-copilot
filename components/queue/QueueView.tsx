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
import { CHECK_LABEL, CHECK_ORDER, SOURCE_LABEL, scoreColor } from "@/lib/checks";
import { DEFAULT_TZ, fmtDateTime, fmtDuration, fmtScore, fmtTime, shortId } from "@/lib/format";
import type { Decision, QueueItem, SubmissionDetail } from "@/lib/types";

const DECISION_LABEL: Record<Decision, string> = { approve: "Approved", backcheck: "Back-check", reject: "Rejected" };
const DECISION_COLOR: Record<Decision, string> = { approve: "bg-ok", backcheck: "bg-accent", reject: "bg-crit" };
const ACTIONS: { decision: Decision; label: string; key: string; className: string }[] = [
  { decision: "approve", label: "Approve", key: "A", className: "text-ok" },
  { decision: "backcheck", label: "Back-check", key: "B", className: "text-accent" },
  { decision: "reject", label: "Reject", key: "R", className: "text-crit" },
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

  const codes = useMemo(() => (overview?.contributors ?? []).map((c) => c.code).sort(), [overview]);
  const fired = current ? CHECK_ORDER.map((key) => current.checks.find((c) => c.key === key && c.fired)).filter(Boolean) : [];

  return (
    <div className="mx-auto grid max-w-[1400px] gap-3 lg:grid-cols-[400px_minmax(0,1fr)]">
      {/* Filters and list */}
      <section aria-label="Queue" className="panel flex flex-col overflow-hidden lg:h-[calc(100vh-7.5rem)]">
        <div className="space-y-2 border-b border-line p-3">
          <div className="flex gap-1 rounded-lg bg-black/25 p-0.5 text-[12px]" role="group" aria-label="Decision state">
            {[
              ["pending", "Waiting"],
              ["decided", "Decided"],
              ["all", "All"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={status === value}
                onClick={() => setFilter("status", value === "pending" ? "" : value)}
                className={`flex-1 rounded-md py-1 ${status === value ? "bg-white/[0.09] text-ink" : "text-muted hover:text-ink"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex gap-2 text-[12px]">
            <label className="flex flex-1 items-center gap-1.5 text-muted">
              <span className="sr-only">Contributor</span>
              <select
                value={contributor}
                onChange={(e) => setFilter("contributor", e.target.value)}
                className="w-full rounded-md border border-line bg-black/25 px-2 py-1 text-ink outline-none focus:border-accent"
              >
                <option value="">All contributors</option>
                {codes.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex rounded-md bg-black/25 p-0.5" role="group" aria-label="Band">
              {[
                ["flagged", "Flagged"],
                ["watch", "Watch"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={band === value}
                  onClick={() => setFilter("band", value === "flagged" ? "" : value)}
                  className={`rounded px-2 py-0.5 ${band === value ? "bg-white/[0.09] text-ink" : "text-muted hover:text-ink"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[11.5px] text-faint">
            {list ? `${list.total} ${list.total === 1 ? "submission" : "submissions"}` : "Loading…"} · highest score first
          </p>
        </div>
        {listError && <p className="p-3 text-[13px] text-crit">{listError}</p>}
        <ul ref={listRef} className="scrollbar-thin flex-1 overflow-y-auto" role="listbox" aria-label="Submissions">
          {items.map((item) => {
            const selected = item.submission_id === selectedId;
            return (
              <li key={item.submission_id} role="option" aria-selected={selected}>
                <Link
                  href={href(item.submission_id)}
                  scroll={false}
                  className={`flex flex-col gap-1 border-b border-line px-3 py-2.5 transition-colors ${
                    selected ? "bg-accent/[0.1]" : "hover:bg-white/[0.025]"
                  }`}
                >
                  <div className="flex items-center gap-2 text-[13px]">
                    <span className="font-mono text-ink">{shortId(item.submission_id)}</span>
                    <span className="font-mono text-muted">{item.contributor.code}</span>
                    <span className="truncate text-faint">{item.contributor.display_name}</span>
                    <span className="ml-auto text-[12px] tabular-nums text-faint">{fmtTime(item.captured_at, tz)}</span>
                    <span
                      className="rounded-md px-1.5 font-mono text-[11px] tabular-nums"
                      style={{ color: scoreColor(item.score, item.band), background: `${scoreColor(item.score, item.band)}1f` }}
                    >
                      {fmtScore(item.score)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    {item.fired.map((key) => (
                      <span key={key} className="rounded bg-white/[0.05] px-1.5 py-px text-[10.5px] text-muted">
                        {CHECK_LABEL[key]}
                      </span>
                    ))}
                    <span className="ml-auto flex items-center gap-1 text-[11px] text-faint">
                      <span className={`dot ${item.review ? DECISION_COLOR[item.review.decision] : "bg-white/20"}`} aria-hidden />
                      {item.review ? DECISION_LABEL[item.review.decision] : "Waiting"}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
          {list && !items.length && <li className="p-4 text-[13px] text-muted">Nothing here. Try another filter.</li>}
        </ul>
      </section>

      {/* Evidence */}
      <section aria-label="Evidence" className="relative flex min-w-0 flex-col lg:h-[calc(100vh-7.5rem)]">
        <div className="scrollbar-thin flex-1 space-y-3 overflow-y-auto pb-24">
          {!current ? (
            <div className="panel p-6 text-sm text-muted">{selectedId ? "Loading the evidence…" : "Pick a submission."}</div>
          ) : (
            <>
              <header className="panel flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
                <div>
                  <p className="font-mono text-lg text-ink">{shortId(current.submission.id)}</p>
                  <p className="text-[12.5px] text-muted">
                    <span className="font-mono text-ink-2">{current.contributor.code}</span> {current.contributor.display_name} ·{" "}
                    <span className="capitalize">{current.contributor.kind}</span> · {current.contributor.area}
                  </p>
                </div>
                <div className="ml-auto flex items-center gap-3">
                  {current.score && (
                    <span
                      className="rounded-lg px-2.5 py-1 font-display text-lg font-semibold tabular-nums"
                      style={{
                        color: scoreColor(current.score.score, current.score.band),
                        background: `${scoreColor(current.score.score, current.score.band)}1a`,
                      }}
                    >
                      {fmtScore(current.score.score)}
                    </span>
                  )}
                  <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
                    <span className={`dot ${activeReview ? DECISION_COLOR[activeReview.decision] : "bg-white/20"}`} aria-hidden />
                    {activeReview ? `${DECISION_LABEL[activeReview.decision]} by ${activeReview.reviewer ?? "reviewer"}` : "Waiting for review"}
                  </span>
                </div>
              </header>

              {fired.length === 0 && <p className="panel p-4 text-[13px] text-muted">No checks fired on this submission.</p>}
              {fired.map((check) => (
                <EvidenceCard key={check!.key} check={check!} detail={current} map={map} tz={tz} />
              ))}

              <RawSubmission detail={current} tz={tz} />
            </>
          )}
        </div>

        <Glass className="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5">
          {ACTIONS.map((a) => (
            <button
              key={a.decision}
              type="button"
              disabled={!current || busy || Boolean(activeReview)}
              onClick={() => void decide(a.decision)}
              className={`flex items-center gap-2 rounded-lg border border-line-strong bg-white/[0.04] px-3 py-1.5 text-[13px] font-medium hover:bg-white/[0.08] disabled:opacity-40 ${a.className}`}
            >
              {a.label} <kbd className="kbd">{a.key}</kbd>
            </button>
          ))}
          <button
            type="button"
            disabled={!activeReview || busy}
            onClick={() => void undo()}
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] text-muted hover:text-ink disabled:opacity-40"
          >
            Undo <kbd className="kbd">U</kbd>
          </button>
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
    <section className="panel p-4" aria-label="Raw submission">
      <h3 className="mb-3 text-[13px] font-medium text-ink">Submission</h3>
      <dl className="grid grid-cols-[130px_1fr] gap-x-4 gap-y-2 text-[13px]">
        <dt className="text-faint">Water source</dt>
        <dd className="text-ink-2">{SOURCE_LABEL[s.answers.water_source ?? ""] ?? s.answers.water_source}</dd>
        <dt className="text-faint">Satisfaction</dt>
        <dd className="font-mono text-ink-2">{(s.answers.satisfaction ?? []).join("  ")}</dd>
        <dt className="text-faint">Open answer</dt>
        <dd className="leading-relaxed text-ink-2">{s.answers.open_text}</dd>
        <dt className="text-faint">Voice transcript</dt>
        <dd className="leading-relaxed text-ink-2">{s.voice_transcript ?? "—"}</dd>
        <dt className="text-faint">Duration</dt>
        <dd className="text-ink-2">{fmtDuration(s.duration_sec)}</dd>
        <dt className="text-faint">Captured</dt>
        <dd className="text-ink-2">{fmtDateTime(s.captured_at, tz)}</dd>
        <dt className="text-faint">Synced</dt>
        <dd className="text-ink-2">
          {fmtDateTime(s.synced_at, tz)} <span className="text-faint">({fmtDuration(Math.max(0, delay))} later)</span>
        </dd>
        <dt className="text-faint">GPS</dt>
        <dd className="font-mono text-[12px] text-ink-2">
          {s.lat?.toFixed(5)}, {s.lng?.toFixed(5)} <span className="text-faint">± {s.gps_accuracy_m ?? "?"} m</span>
        </dd>
        <dt className="text-faint">Device</dt>
        <dd className="font-mono text-[12px] text-ink-2">{s.device_id}</dd>
        <dt className="text-faint">Source</dt>
        <dd className="text-ink-2">{s.source}</dd>
      </dl>
    </section>
  );
}
