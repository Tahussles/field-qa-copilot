"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { sendBeat, type Beat } from "@/lib/beats";

/** The demo, beat by beat, with the time each should start (seconds from the start of the demo). */
export const BEATS: { key: string; label: string; at: number; hint?: string; jump?: string }[] = [
  { key: "landing", label: "Landing: rewards invite fakes", at: 0, jump: "Open /" },
  { key: "brief", label: "The morning brief: who to look at first", at: 40, jump: "Open brief" },
  { key: "hotspot", label: "E07's tea-shop hotspot on the map", at: 90, jump: "Focus E07" },
  { key: "queue", label: "E07 in the queue: evidence, then A / B / R", at: 150, jump: "Open E07" },
  { key: "detectors", label: "Detectors: drag the threshold, watch precision", at: 220, jump: "Detectors" },
  { key: "phone", label: "Phone: scan the QR, record a contradiction", at: 280, jump: "Phone QR" },
  {
    key: "clock",
    label: "Phone clock off by 3 h",
    at: 370,
    hint: "On the phone: Demo controls → Phone clock off by 3 h, then submit. Clock skew + Off hours flag it.",
  },
  { key: "architecture", label: "How it works", at: 420, jump: "/architecture" },
  { key: "pitch", label: "Proof and what's next", at: 480, jump: "/pitch" },
];
export const SCRIPT_TARGET_S = 540;

const KEY = "fqc-demo-script";
type Saved = { startedAt: number | null; done: string[] };

function load(): Saved {
  try {
    return { startedAt: null, done: [], ...JSON.parse(window.localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { startedAt: null, done: [] };
  }
}

function save(state: Saved) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // private mode: the script still works for this page
  }
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The Script tab: the beats as a checklist with jump buttons, a running timer and each beat's target time. */
export function DemoScript({ onPhone }: { onPhone: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<Saved>({ startedAt: null, done: [] });
  const [now, setNow] = useState(0);

  useEffect(() => {
    queueMicrotask(() => {
      setState(load());
      setNow(Date.now());
    });
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const update = (next: Saved) => {
    setState(next);
    save(next);
  };
  const elapsed = state.startedAt ? Math.max(0, (now - state.startedAt) / 1000) : 0;
  const current = state.startedAt ? BEATS.filter((b) => b.at <= elapsed).at(-1)?.key : null;

  function beat(b: Beat) {
    if (pathname === "/app") sendBeat(b);
    else router.push(b.beat === "brief" ? "/app?beat=brief" : `/app?beat=hotspot&code=${b.code}`);
  }

  function jump(key: string) {
    if (!state.startedAt) update({ ...state, startedAt: Date.now() });
    const go: Record<string, () => void> = {
      landing: () => router.push("/"),
      brief: () => beat({ beat: "brief" }),
      hotspot: () => beat({ beat: "hotspot", code: "E07" }),
      queue: () => router.push("/app/queue?contributor=E07"),
      detectors: () => router.push("/app/detectors"),
      phone: onPhone,
      architecture: () => router.push("/architecture"),
      pitch: () => router.push("/pitch"),
    };
    go[key]?.();
  }

  const toggle = (key: string) =>
    update({ ...state, done: state.done.includes(key) ? state.done.filter((k) => k !== key) : [...state.done, key] });

  return (
    <div className="mt-3" data-testid="demo-script">
      <div className="flex items-center gap-2">
        <span className={`font-mono text-[18px] ${elapsed > SCRIPT_TARGET_S ? "text-warn" : "text-ink"}`} data-testid="script-timer">
          {clock(elapsed)}
        </span>
        <span className="text-[11.5px] text-muted">of {clock(SCRIPT_TARGET_S)}</span>
        <div className="ml-auto flex gap-1.5">
          {state.startedAt ? (
            <button type="button" className="btn btn-sm" onClick={() => update({ startedAt: null, done: [] })}>
              Reset
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => update({ ...state, startedAt: Date.now() })}>
              Start
            </button>
          )}
        </div>
      </div>
      <ol className="mt-2.5 flex flex-col gap-1">
        {BEATS.map((b, i) => {
          const done = state.done.includes(b.key);
          const next = BEATS[i + 1]?.at ?? SCRIPT_TARGET_S;
          const late = Boolean(state.startedAt) && !done && elapsed > next;
          return (
            <li key={b.key} className={`rounded-md px-1.5 py-1 ${current === b.key ? "bg-overlay/[0.06]" : ""}`}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={done} onChange={() => toggle(b.key)} aria-label={`Done: ${b.label}`} />
                <span className={`w-9 flex-none font-mono text-[11px] ${late ? "text-warn" : "text-faint"}`}>{clock(b.at)}</span>
                <span className={`min-w-0 flex-1 ${done ? "text-faint line-through" : "text-ink-2"}`}>{b.label}</span>
                {b.jump && (
                  <button type="button" className="btn btn-sm flex-none px-2 py-0.5 text-[11px]" onClick={() => jump(b.key)} data-testid={`jump-${b.key}`}>
                    {b.jump}
                  </button>
                )}
              </div>
              {b.hint && <p className="mt-0.5 pl-[58px] text-[11px] text-muted">{b.hint}</p>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
