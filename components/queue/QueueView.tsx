"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppData } from "@/components/app/AppData";
import { isTyping } from "@/components/app/AppShell";
import { useWithPasscode } from "@/components/app/Passcode";
import { useToast } from "@/components/app/Toasts";
import { EvidenceRow } from "@/components/queue/EvidenceCards";
import { Section } from "@/components/ui/Disclosure";
import { Glass } from "@/components/ui/Glass";
import { Tip, useTip } from "@/components/ui/Tip";
import { api } from "@/lib/api";
import { CHECK_ORDER, CHECK_TITLE, SOURCE_LABEL, scoreClass, submissionMainSignal } from "@/lib/checks";
import { DEFAULT_TZ, fmtDateTime, fmtDayMonth, fmtDuration, fmtScore, fmtStamp, fmtTime, shortId } from "@/lib/format";
import type { CheckKey, ContributorRow, Decision, QueueItem, SubmissionDetail } from "@/lib/types";

// Decision wording and colours follow the prototype.
const DECISION_LABEL: Record<Decision, string> = {
  approve: "Approved as genuine",
  backcheck: "Sent for back-check",
  reject: "Rejected as fabricated",
};
const DECISION_CLASS: Record<Decision, string> = { approve: "st-ok", backcheck: "st-info", reject: "st-crit" };
const ACTIONS: { decision: Decision; label: string; short: string; key: string; className: string }[] = [
  { decision: "approve", label: "Approve as genuine", short: "Approve", key: "A", className: "text-ok" },
  { decision: "backcheck", label: "Send for back-check", short: "Back-check", key: "B", className: "" },
  { decision: "reject", label: "Reject as fabricated", short: "Reject", key: "R", className: "text-crit" },
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
  const barRef = useRef<HTMLDivElement>(null);
  // Which evidence rows are open, for one submission; a new selection starts from its main signal.
  const [openRows, setOpenRows] = useState<{ id: string | null; keys: CheckKey[] }>({ id: null, keys: [] });

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

  const people = useMemo(
    () => [...(overview?.contributors ?? [])].sort((a, b) => a.code.localeCompare(b.code)),
    [overview],
  );
  const byCode = useMemo(() => new Map((overview?.contributors ?? []).map((c) => [c.code, c])), [overview]);
  const fired = useMemo(
    () => (current ? CHECK_ORDER.map((key) => current.checks.find((c) => c.key === key && c.fired)).filter((c) => c != null) : []),
    [current],
  );
  const firedKeys = useMemo(() => fired.map((c) => c.key), [fired]);
  const lead = current ? submissionMainSignal(firedKeys, byCode.get(current.contributor.code)?.checks_fired) : null;
  const openKeys = current && openRows.id === current.submission.id ? openRows.keys : lead ? [lead] : [];
  const allOpen = firedKeys.length > 0 && firedKeys.every((k) => openKeys.includes(k));
  const toggleRow = (key: CheckKey) =>
    current && setOpenRows({ id: current.submission.id, keys: openKeys.includes(key) ? openKeys.filter((k) => k !== key) : [...openKeys, key] });
  const toggleAll = useCallback(() => {
    if (current) setOpenRows({ id: current.submission.id, keys: allOpen ? [] : firedKeys });
  }, [current, allOpen, firedKeys]);
  const canUndo = Boolean(activeReview || lastDecision);

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
        : key === "e" ? toggleAll()
        : key === "j" || key === "arrowdown" ? move(1)
        : key === "k" || key === "arrowup" ? move(-1)
        : "skip";
      if (handled !== "skip") event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, undo, move, toggleAll]);

  // The action bar floats over the evidence; keep focused and scrolled-to content clear of it.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => root.style.setProperty("--action-bar-h", `${bar.offsetHeight}px`));
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--action-bar-h");
    };
  }, []);

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
        {overview && (
          <p className="flex gap-3 border-b border-line px-3 py-1.5 font-mono text-[11.5px] text-muted" data-testid="queue-counts">
            <span title="In this list">{list?.total ?? "…"}</span>
            <span>{overview.kpis.flagged - overview.kpis.pending_review} decided</span>
          </p>
        )}
        {listError && <p className="p-3 text-[13px] text-crit">{listError}</p>}
        <ul
          ref={listRef}
          className="scrollbar-thin max-h-[min(calc(100vh-240px),560px)] min-h-[200px] overflow-y-auto p-1"
          role="listbox"
          aria-label="Submissions"
        >
          {items.map((item) => (
            <QueueRow
              key={item.submission_id}
              item={item}
              selected={item.submission_id === selectedId}
              href={href(item.submission_id)}
              tz={tz}
              contributor={byCode.get(item.contributor.code)}
              showCode={!contributor}
            />
          ))}
          {list && !items.length && <li className="px-2.5 py-3 text-muted">Nothing here. Change the filter.</li>}
          {!list && !listError && <li className="px-2.5 py-3 text-muted">Loading…</li>}
        </ul>
      </section>

      {/* Evidence: the verdict, why it was flagged (one row per check), and the submission itself. */}
      <section aria-label="Evidence" className="flex min-w-0 flex-col gap-4">
        {!current ? (
          <div className="panel px-4 py-3.5 text-muted">{selectedId ? "Loading the evidence…" : "The queue is clear."}</div>
        ) : (
          <>
            <Verdict detail={current} tz={tz} review={activeReview} />
            <Section
              title="Why flagged"
              aria-label="Why it was flagged"
              summary={fired.length ? String(fired.length) : null}
              actions={
                fired.length > 1 && (
                  <Tip content={`${allOpen ? "Close" : "Open"} all · E`} className="inline-flex">
                    <button type="button" onClick={toggleAll} className="btn btn-sm btn-ghost px-1.5" aria-keyshortcuts="E"
                      aria-label={allOpen ? "Collapse all" : "Expand all"} data-testid="expand-all">
                      <IconExpand open={allOpen} />
                    </button>
                  </Tip>
                )
              }
              bodyClassName="grid gap-2 p-4"
            >
              {fired.length === 0 && <p className="text-muted">No checks fired on this submission.</p>}
              {fired.map((check) => (
                <EvidenceRow
                  key={check.key}
                  check={check}
                  detail={current}
                  map={map}
                  tz={tz}
                  open={openKeys.includes(check.key)}
                  onToggle={() => toggleRow(check.key)}
                />
              ))}
            </Section>
            <Section
              title="Submission details"
              aria-label="Submission details"
              collapsible
              defaultOpen={false}
              storeKey="queue-details"
              data-testid="submission-details"
            >
              <RawSubmission detail={current} tz={tz} />
            </Section>
          </>
        )}

        {/* Above the phone's bottom nav on small screens. */}
        <Glass
          ref={barRef}
          className="sticky bottom-[84px] z-[3] flex flex-wrap items-center gap-2 rounded-xl px-[18px] py-3 md:bottom-3"
          data-testid="action-bar"
        >
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
                aria-label={a.label}
                aria-keyshortcuts={a.key}
              >
                <span className={a.className}>{a.short}</span>
                <kbd className="kbd">{a.key}</kbd>
              </button>
            ))
          )}
          {canUndo && (
            <button type="button" disabled={busy} onClick={() => void undo()} className="btn btn-sm">
              Undo{!activeReview && lastDecision ? ` ${shortId(lastDecision.submissionId)}` : ""} <kbd className="kbd">U</kbd>
            </button>
          )}
          <span className="ml-auto font-mono text-[11.5px] text-muted" aria-label={index >= 0 ? `${index + 1} of ${items.length}` : undefined}>
            {index >= 0 ? `${index + 1}/${items.length}` : items.length}
          </span>
        </Glass>
      </section>
    </div>
  );
}

/** One queue row: id, contributor, local time and score, then the lead check and "+N"; all checks in a tooltip. */
function QueueRow({ item, selected, href, tz, contributor, showCode }: {
  item: QueueItem;
  selected: boolean;
  href: string;
  tz: string;
  contributor?: ContributorRow;
  showCode: boolean;
}) {
  const review = item.review && !item.review.revoked_at ? item.review : null;
  const lead = submissionMainSignal(item.fired, contributor?.checks_fired);
  const rest = item.fired.length - (lead ? 1 : 0);
  const { triggerProps, tip } = useTip(
    <>
      <b className="font-medium text-ink">{fmtStamp(item.captured_at, tz)}</b> ·{" "}
      {item.fired.length ? item.fired.map((k) => CHECK_TITLE[k]).join(" · ") : "no checks fired"}
    </>,
    { delay: 450 },
  );
  return (
    <li role="option" aria-selected={selected}>
      <Link
        href={href}
        scroll={false}
        {...triggerProps}
        className={`flex flex-col gap-[5px] rounded-[7px] px-2.5 py-2 ${
          selected ? "bg-overlay/[0.06] shadow-[inset_2px_0_0_var(--color-accent)]" : "hover:bg-hover"
        } ${review && !selected ? "opacity-50" : ""}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate">
            <span className="font-mono">{shortId(item.submission_id)}</span>{" "}
            {item.source === "live" && (
              <span className="live-tag" title="Sent from a phone on /collect">Live</span>
            )}{" "}
            <span className="text-muted">
              {showCode && `${item.contributor.code} · `}
              {fmtDayMonth(item.captured_at, tz)}
            </span>
          </span>
          <span className="flex flex-none items-center gap-1.5">
            {item.ai_pending && (
              <span className="ai-spinner" role="status" aria-label="A model is still checking this one" title="A model is still checking this one" />
            )}
            <span className={scoreClass(item.score, item.band)}>{fmtScore(item.score)}</span>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1" data-testid="row-checks">
          {lead && <span className="chip">{CHECK_TITLE[lead]}</span>}
          {rest > 0 && <span className="chip" aria-label={`and ${rest} more`}>+{rest}</span>}
          {review && (
            <span className={`st ${DECISION_CLASS[review.decision]}`}>
              <span>{DECISION_LABEL[review.decision]}</span>
            </span>
          )}
        </div>
      </Link>
      {tip}
    </li>
  );
}

/** The verdict card: who, where, when, how long, the score and its band, and the decision so far. */
function Verdict({ detail, tz, review }: { detail: SubmissionDetail; tz: string; review: SubmissionDetail["review"] }) {
  const s = detail.submission;
  const score = detail.score;
  const band = score?.band === "flagged" ? "Flagged" : score?.band === "watch" ? "Watch" : "Passed";
  const facts: [string, string][] = [
    [detail.contributor.kind === "enumerator" ? "Enumerator" : "Participant", `${detail.contributor.display_name ?? ""} ${detail.contributor.code}`],
    ["Area", detail.contributor.area ?? ""],
    ["Captured", `${fmtDayMonth(s.captured_at, tz)} ${fmtTime(s.captured_at, tz)}`],
    ["Duration", fmtDuration(s.duration_sec)],
  ];
  return (
    <Section
      title="Verdict"
      aria-label="Verdict"
      actions={
        review ? (
          <span className={`st ${DECISION_CLASS[review.decision]}`} data-testid="decision-state">
            <span>{DECISION_LABEL[review.decision]}</span>
          </span>
        ) : (
          <span className="st st-warn" data-testid="decision-state">
            <span>To review</span>
          </span>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="font-mono text-[18px] font-medium tracking-normal">{shortId(s.id)}</h2>
        {s.source === "live" && <span className="live-tag">Live</span>}
        {score && (
          <span className="ml-auto flex items-center gap-2" data-testid="verdict-score">
            <span className={scoreClass(score.score, score.band)} aria-label={`Score ${fmtScore(score.score)}`}>{fmtScore(score.score)}</span>
            <span className={`st ${score.band === "flagged" ? (score.score >= 5 ? "st-crit" : "st-warn") : score.band === "watch" ? "st-warn" : "st-ok"}`}>
              <span>{band}</span>
            </span>
          </span>
        )}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-2">
        {facts.map(([label, value]) => (
          <li key={label} aria-label={`${label}: ${value}`}>
            <Tip content={label} className="cursor-default">
              {value}
            </Tip>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function IconExpand({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.6}>
      {open ? <path d="M4 7l4-3 4 3M4 12l4-3 4 3" /> : <path d="M4 4l4 3 4-3M4 9l4 3 4-3" />}
    </svg>
  );
}

function RawSubmission({ detail, tz }: { detail: SubmissionDetail; tz: string }) {
  const s = detail.submission;
  const delay = (new Date(s.synced_at).getTime() - new Date(s.captured_at).getTime()) / 1000;
  const phoneTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-[12.5px] sm:grid-cols-[150px_1fr] [&_dd]:text-ink-2 [&_dt]:text-faint" aria-label="Raw submission">
      <dt>Water source</dt>
      <dd>{SOURCE_LABEL[s.answers.water_source ?? ""] ?? s.answers.water_source}</dd>
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
      <dt>Voice note</dt>
      <dd>{s.voice_transcript ? `"${s.voice_transcript}"` : "—"}</dd>
      <dt>GPS</dt>
      <dd className="font-mono text-[12px]">
        {s.lat?.toFixed(5)}, {s.lng?.toFixed(5)} <span className="text-faint">± {s.gps_accuracy_m ?? "?"} m</span>
      </dd>
      <dt>Captured (field)</dt>
      <dd>{fmtDateTime(s.captured_at, tz)}</dd>
      <dt>Synced (field)</dt>
      <dd>
        {fmtDateTime(s.synced_at, tz)} <span className="text-faint">({fmtDuration(Math.max(0, delay))} later)</span>
      </dd>
      {s.device_captured_at && (
        <>
          <dt>Phone clock</dt>
          <dd>
            captured {fmtDateTime(s.device_captured_at, phoneTz)}
            {s.device_synced_at && <> · sent {fmtDateTime(s.device_synced_at, phoneTz)}</>}
            {s.received_at && <span className="text-faint"> · server received {fmtDateTime(s.received_at, phoneTz)}</span>}
          </dd>
        </>
      )}
      <dt>Device</dt>
      <dd className="font-mono text-[12px]">{s.device_id}</dd>
      <dt>Source</dt>
      <dd>{s.source}</dd>
    </dl>
  );
}
