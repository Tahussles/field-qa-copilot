"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { DemoScript } from "@/components/app/DemoScript";
import { useWithPasscode } from "@/components/app/Passcode";
import { useToast } from "@/components/app/Toasts";
import { Glass } from "@/components/ui/Glass";
import { api, ApiError } from "@/lib/api";
import { DEFAULT_TZ, fmtDateTime, fmtStamp, fmtTime, localDate } from "@/lib/format";
import type { DemoMoment, DemoProgress, DemoStatus, DemoStepResult } from "@/lib/types";

/** Wall-clock seconds per field hour. */
const SPEEDS = [3, 6, 12] as const;
const TICK_MS = 250;
const STEP_MAX = 50;
/** After "Skip to next key moment" the field clock waits this long (field time) before the moment. */
const PARK_MS = 30_000;
const LIVE_DAY = "2026-10-31";

const DemoContext = createContext<{ open: boolean; toggle: () => void }>({ open: false, toggle: () => {} });

export function useDemo() {
  return useContext(DemoContext);
}

/**
 * The presenter's controls. The runner lives here, in the browser: it walks a field
 * clock forward and calls /demo/step whenever the next live-day submission is due,
 * so enumerator batches (seconds apart) arrive together and participants trickle
 * in. Everything else in the app updates through Realtime, as if phones synced.
 * The D key (AppShell's shortcuts) and the sidebar link open the panel.
 */
export function DemoProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  return (
    <DemoContext.Provider value={{ open, toggle }}>
      {children}
      <DemoRunner open={open} onClose={() => setOpen(false)} />
    </DemoContext.Provider>
  );
}

const iso = (ms: number) => new Date(ms).toISOString();
const parse = (value: string | null | undefined) => (value ? Date.parse(value) : null);

/** A moment has passed once the next pending submission syncs after it. */
function passed(moment: DemoMoment, progress: DemoProgress) {
  const next = parse(progress.next_field_time);
  return next == null || next > Date.parse(moment.field_time);
}

function DemoRunner({ open, onClose }: { open: boolean; onClose: () => void }) {
  const withPasscode = useWithPasscode();
  const toast = useToast();
  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [tab, setTab] = useState<"controls" | "script">("controls");
  const [locked, setLocked] = useState(false);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(6);
  const [clock, setClock] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const [phone, setPhone] = useState<{ url: string; svg: string; expires: number } | null>(null);

  const runningRef = useRef(false);
  const speedRef = useRef<number>(speed);
  const anchor = useRef({ wall: 0, field: 0 });
  const inFlight = useRef<Promise<unknown> | null>(null);
  const next = useRef<number | null>(null);
  const interval = useRef<number | null>(null);

  const frozen = useRef(false);
  // While a step is sending, the field clock waits for it to land, so it never runs ahead of what has arrived.
  const fieldNow = () =>
    frozen.current ? anchor.current.field : anchor.current.field + ((performance.now() - anchor.current.wall) * 3600) / speedRef.current;

  const load = useCallback(async () => {
    const result = await withPasscode((code) => api.demoStatus(code));
    setLocked(result == null);
    if (result) {
      setStatus(result);
      next.current = parse(result.progress.next_field_time);
    }
    return result;
  }, [withPasscode]);

  useEffect(() => {
    if (open && !status) queueMicrotask(() => void load().catch(() => setLocked(true)));
  }, [open, status, load]);

  const apply = useCallback((res: DemoStepResult) => {
    setStatus((s) => (s ? { ...s, progress: res.progress } : s));
    next.current = parse(res.progress.next_field_time);
    if (res.results.length) {
      const flagged = res.results.filter((r) => r.flagged).length;
      const codes = [...new Set(res.results.map((r) => r.code))];
      setLast(
        `Synced ${res.results.length} from ${codes.slice(0, 3).join(", ")}${codes.length > 3 ? ` +${codes.length - 3}` : ""}` +
          (flagged ? ` · ${flagged} flagged` : ""),
      );
    }
    if (res.error) toast({ tone: "error", title: "Step stopped", body: res.error });
  }, [toast]);

  const stopTimer = () => {
    if (interval.current) window.clearInterval(interval.current);
    interval.current = null;
  };

  const pause = useCallback(() => {
    if (runningRef.current) setClock(fieldNow());
    runningRef.current = false;
    setRunning(false);
    stopTimer();
  }, []);

  const runId = useRef<string | null>(null);
  useEffect(() => {
    runId.current = status?.run_id ?? null;
  }, [status?.run_id]);

  const step = useCallback(
    async (body: { count?: number; until_field_time?: string }) => {
      try {
        const res = await withPasscode((code) => api.demoStep(code, { run_id: runId.current ?? "", ...body }));
        if (res) apply(res);
        return res;
      } catch (e) {
        // 409: someone reset the demo (another tab). Stop here and pick up the new run.
        if (e instanceof ApiError && e.status === 409) {
          runningRef.current = false;
          setRunning(false);
          if (interval.current) window.clearInterval(interval.current);
          interval.current = null;
          setClock(null);
          setLast(null);
          toast({ tone: "error", title: "The demo was reset elsewhere", body: "this run stopped; press Start to replay the new run" });
          void load();
          return null;
        }
        throw e;
      }
    },
    [withPasscode, apply, toast, load],
  );

  const tick = useCallback(async () => {
    if (!runningRef.current) return;
    const now = fieldNow();
    setClock(now);
    if (next.current == null) {
      pause();
      return;
    }
    if (inFlight.current || next.current > now) return;
    anchor.current = { wall: performance.now(), field: now };
    frozen.current = true;
    const sending = step({ until_field_time: iso(now), count: STEP_MAX });
    inFlight.current = sending;
    try {
      const res = await sending;
      if (!res) pause();
      else if (res.progress.done) {
        pause();
        toast({ tone: "ok", title: "Live day complete", body: `${res.progress.sent} submissions synced` });
      }
    } catch (e) {
      pause();
      toast({ tone: "error", title: "Demo step failed", body: e instanceof Error ? e.message : undefined });
    } finally {
      anchor.current = { wall: performance.now(), field: now };
      frozen.current = false;
      inFlight.current = null;
    }
  }, [pause, step, toast]);

  /** Pause, and let a step that is still sending finish first, so reset and skip never race it. */
  const settle = useCallback(async () => {
    pause();
    await inFlight.current?.catch(() => {});
  }, [pause]);

  function start() {
    if (!status || status.progress.done) return;
    anchor.current = { wall: performance.now(), field: clock ?? parse(status.progress.field_clock) ?? Date.now() };
    runningRef.current = true;
    setRunning(true);
    stopTimer();
    interval.current = window.setInterval(() => void tick(), TICK_MS);
    void tick();
  }

  function changeSpeed(value: (typeof SPEEDS)[number]) {
    if (runningRef.current) anchor.current = { wall: performance.now(), field: fieldNow() };
    speedRef.current = value;
    setSpeed(value);
  }

  const currentClock = clock ?? parse(status?.progress.field_clock) ?? null;
  const upcoming =
    status && currentClock != null
      ? status.moments.find(
          (m) => !passed(m, status.progress) && Date.parse(m.field_time) > currentClock + PARK_MS + 1000,
        ) ?? null
      : null;

  async function skip() {
    if (!upcoming) return;
    setBusy(`Skipping to ${upcoming.label}…`);
    await settle();
    const target = Date.parse(upcoming.field_time) - 1000;
    try {
      for (;;) {
        const res = await step({ until_field_time: iso(target), count: STEP_MAX });
        if (!res || res.error || res.results.length < STEP_MAX) break;
      }
      setClock(Math.max(target + 1000 - PARK_MS, currentClock ?? 0));
    } catch (e) {
      toast({ tone: "error", title: "Skip failed", body: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(null);
      void load(); // progress and spend
    }
  }

  async function showPhone() {
    setBusy("Making a phone code…");
    try {
      const minted = await withPasscode((code) => api.collectToken(code));
      if (minted) {
        const url = `${window.location.origin}${minted.path}`;
        const QRCode = (await import("qrcode")).default;
        const svg = await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#08090a", light: "#ffffff" } });
        setPhone({ url, svg, expires: minted.expires_at });
      }
    } catch (e) {
      toast({ tone: "error", title: "Could not make a phone code", body: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setConfirming(false);
    setBusy("Resetting…");
    await settle();
    try {
      const res = await withPasscode((code) => api.demoReset(code));
      if (res) {
        setClock(null);
        setLast(null);
        setPhone(null); // the reset revoked its token
        await load(); // fresh progress first, so the panel never shows the old run next to the toast
        toast({
          tone: "ok",
          title: "Demo reset",
          body: `removed ${res.deleted.submissions} live submissions and ${res.deleted.reviews} reviews`,
        });
      }
    } catch (e) {
      toast({ tone: "error", title: "Reset failed", body: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => () => stopTimer(), []);

  if (!open) return null;
  const progress = status?.progress;
  const tz = DEFAULT_TZ;
  const flaggedLabel = currentClock != null && localDate(iso(currentClock), tz) !== LIVE_DAY ? "in the live day" : "today";

  return (
    <Glass
      role="dialog"
      aria-label="Demo controls"
      onKeyDown={(e: React.KeyboardEvent) => e.key === "Escape" && onClose()}
      className="glass-tint fixed inset-x-3 bottom-[76px] z-40 max-h-[70vh] overflow-auto rounded-xl p-4 text-[12.5px] md:inset-x-auto md:right-5 md:bottom-5 md:w-[360px]"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-[14px] font-semibold">Demo controls</h2>
        <span className={`st ${running ? "st-ok" : "st-info"} text-[11.5px]`}>
          <span>{busy ?? (running ? "Running" : progress?.done ? "Live day done" : "Paused")}</span>
        </span>
        <kbd className="kbd ml-auto">D</kbd>
        <button type="button" onClick={onClose} aria-label="Close demo controls" className="btn btn-ghost btn-sm px-1.5">
          ×
        </button>
      </div>
      <div className="mt-2.5 inline-flex rounded-md border border-line p-0.5" role="tablist" aria-label="Demo panel">
        {(["controls", "script"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded px-2.5 py-0.5 text-[11.5px] ${tab === t ? "bg-white/[0.1] text-ink" : "text-muted hover:text-ink"}`}
          >
            {t === "controls" ? "Controls" : "Script"}
          </button>
        ))}
      </div>

      {tab === "script" ? (
        <DemoScript
          onPhone={() => {
            setTab("controls");
            void showPhone();
          }}
        />
      ) : locked && !status ? (
        <div className="mt-3">
          <p className="text-muted">The demo controls change shared data, so they need the demo passcode.</p>
          <button type="button" onClick={() => void load()} className="btn btn-sm mt-2">
            Unlock
          </button>
        </div>
      ) : !status || !progress ? (
        <p className="mt-3 text-muted">Loading the live day…</p>
      ) : (
        <>
          <p data-testid="demo-progress" className="mt-2.5 font-mono text-[11.5px] text-ink-2">
            {currentClock != null ? fmtDateTime(iso(currentClock), tz) : "—"} · {progress.sent} / {progress.total} sent ·{" "}
            {progress.flagged} flagged {flaggedLabel}
          </p>
          <p className="mt-0.5 text-[11.5px] text-muted">
            {progress.next_field_time ? `Next sync ${fmtStamp(progress.next_field_time, tz)}` : "Every live-day submission has synced"}
            {last && ` · ${last}`}
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => (running ? (pause(), void load()) : start())}
              disabled={Boolean(busy) || progress.done}
              className="btn btn-primary btn-sm"
            >
              {running ? "Pause live day" : progress.sent ? "Resume live day" : "Start live day"}
            </button>
            <button type="button" onClick={() => void skip()} disabled={Boolean(busy) || !upcoming} className="btn btn-sm">
              Skip to next key moment
            </button>
          </div>

          <div className="mt-3 flex items-center gap-2 text-muted" role="group" aria-label="Speed">
            1 field hour =
            <span className="inline-flex rounded-md border border-line p-0.5">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={speed === s}
                  onClick={() => changeSpeed(s)}
                  className={`rounded px-2 py-0.5 font-mono text-[11.5px] ${speed === s ? "bg-white/[0.1] text-ink" : "hover:text-ink"}`}
                >
                  {s} s
                </button>
              ))}
            </span>
          </div>

          <h3 className="mt-3.5 mb-1 text-[11.5px] font-medium text-muted">Key moments</h3>
          <ol className="flex flex-col">
            {status.moments.map((m) => {
              const done = passed(m, progress);
              const isNext = upcoming?.key === m.key;
              return (
                <li key={m.key} className={`flex items-baseline gap-2 py-[3px] ${done ? "text-faint" : "text-ink-2"}`}>
                  <span className="w-[86px] flex-none font-mono text-[11px]">{fmtStamp(m.field_time, tz)}</span>
                  <span className="min-w-0 flex-1 truncate" title={m.codes.join(", ")}>
                    {m.label}
                  </span>
                  {done ? (
                    <span className="text-[11px]">arrived</span>
                  ) : isNext ? (
                    <span className="text-[11px] text-accent">next</span>
                  ) : null}
                </li>
              );
            })}
          </ol>

          <div className="mt-3.5 border-t border-line pt-3" data-testid="phone-section">
            <div className="flex items-center gap-2">
              <h3 className="text-[11.5px] font-medium text-muted">Phone</h3>
              <button type="button" onClick={() => void showPhone()} disabled={Boolean(busy)} className="btn btn-sm ml-auto">
                {phone ? "New code" : "Show QR for /collect"}
              </button>
            </div>
            {phone && (
              <div className="mt-2 flex items-start gap-3">
                <div className="h-[108px] w-[108px] flex-none overflow-hidden rounded-md bg-white p-1" data-testid="phone-qr"
                  // QRCode's own SVG for a URL we made: no user content in it.
                  dangerouslySetInnerHTML={{ __html: phone.svg }} />
                <div className="min-w-0 text-[11.5px] text-muted">
                  <a href={phone.url} target="_blank" rel="noreferrer" className="block break-all font-mono text-ink-2 hover:text-accent" data-testid="phone-url">
                    {phone.url.replace(/^https?:\/\//, "")}
                  </a>
                  <p className="mt-1">Valid until {fmtTime(new Date(phone.expires * 1000).toISOString(), tz)} (30 min); a reset revokes it.</p>
                </div>
              </div>
            )}
          </div>

          <p className="mt-3 text-[11.5px] text-muted" data-testid="ai-spend">
            AI spend <span className="font-mono text-ink-2">${status.ai_spend.run_usd.toFixed(4)}</span> this run ({status.ai_spend.run_jobs} jobs) ·{" "}
            <span className="font-mono text-ink-2">${status.ai_spend.all_time_usd.toFixed(2)}</span> all time
          </p>

          <div className="mt-3.5 border-t border-line pt-3">
            {confirming ? (
              <div role="alert">
                <p className="text-ink-2">
                  Delete the {progress.sent} live-day submissions and every review, rescore the wave, and set the clock back to
                  Oct 31, 08:00?
                </p>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={() => setConfirming(false)} className="btn btn-ghost btn-sm">
                    Cancel
                  </button>
                  <button type="button" onClick={() => void reset()} className="btn btn-sm border-crit/50 text-crit">
                    Reset demo
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} disabled={Boolean(busy)} className="btn btn-sm">
                Reset demo
              </button>
            )}
          </div>
        </>
      )}
    </Glass>
  );
}
