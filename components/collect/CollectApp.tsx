"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Recorder, type VoiceNote } from "@/components/collect/Recorder";
import { ResultScreen } from "@/components/collect/ResultScreen";
import { Section } from "@/components/ui/Disclosure";
import { Glass } from "@/components/ui/Glass";
import { passcodeStore } from "@/lib/api";
import { SOURCE_LABEL } from "@/lib/checks";
import { CollectError, collectApi, type Access } from "@/lib/collect/api";
import { CLOCK_OFF_MINUTES, clockOffsetMinutes, phoneNow, setClockOffsetMinutes } from "@/lib/collect/clock";
import { newHousehold, realGps, sameSpot, type Fix } from "@/lib/collect/location";
import { backoffMs, outbox, type OutboxItem } from "@/lib/collect/outbox";
import { DEFAULT_TZ, fmtTime } from "@/lib/format";
import type { CollectContributor, CollectSession } from "@/lib/types";

const TOKEN_KEY = "fqc-collect-token";
const DEVICE_KEY = "fqc-device-id";
const CONTRIBUTOR_KEY = "fqc-collect-contributor";
const ITEMS = ["Reliability", "Distance", "Cost", "Water quality", "Waiting time", "Safety", "Opening hours", "Overall"];
const DEFAULT_MINUTES = 27;
const SYNC_EVERY_MS = 2000;

const store = {
  get: (k: string) => {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v == null) window.localStorage.removeItem(k);
      else window.localStorage.setItem(k, v);
    } catch {
      // private mode: this phone forgets between visits
    }
  },
};

/** This phone's id: made on first open and kept, like a real handset's. */
function deviceId(): string {
  let id = store.get(DEVICE_KEY);
  if (!id) {
    id = `phone-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    store.set(DEVICE_KEY, id);
  }
  return id;
}

export function CollectApp() {
  const params = useSearchParams();
  const [access, setAccess] = useState<Access | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [session, setSession] = useState<CollectSession | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const syncing = useRef(false);

  // Access: the QR code's token (kept for later visits), else the passcode this browser already knows.
  useEffect(() => {
    const fromUrl = params.get("t");
    if (fromUrl) store.set(TOKEN_KEY, fromUrl);
    const token = fromUrl ?? store.get(TOKEN_KEY);
    const passcode = passcodeStore.get();
    queueMicrotask(() => {
      setDevice(deviceId());
      setCode(store.get(CONTRIBUTOR_KEY));
      setOnline(navigator.onLine);
      setAccess(token ? { token } : passcode ? { passcode } : null);
    });
  }, [params]);

  useEffect(() => {
    if (!access) return;
    let cancelled = false;
    collectApi.session(access).then(
      (s) => !cancelled && (setSession(s), setRefused(null)),
      (e) => {
        if (cancelled) return;
        if (e instanceof CollectError && e.status === 401) {
          if ("token" in access) store.set(TOKEN_KEY, null);
          setAccess(null);
          setRefused(e.message);
        } else setRefused(`Could not load the project (${e instanceof Error ? e.message : "error"}). Reload when online.`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [access]);

  const reload = useCallback(async () => setItems(await outbox.all()), []);

  // The sync loop: oldest waiting item first, backoff after a failure, once at a time.
  const sync = useCallback(async () => {
    if (!access || syncing.current || !navigator.onLine) return;
    syncing.current = true;
    try {
      for (const item of await outbox.all()) {
        if (item.status === "synced" || (item.status === "error" && item.next_try_at === Infinity)) continue;
        if (item.next_try_at > Date.now()) continue;
        await outbox.update(item.client_submission_id, { status: "syncing" });
        await reload();
        try {
          const { path, result } = await collectApi.send(access, item);
          // The phone's own clock: during a demo the server's synced_at is on the field clock (result.synced_at).
          await outbox.update(item.client_submission_id, {
            status: "synced", result, voice_note_path: path, synced_at: phoneNow().toISOString(), error: null,
          });
        } catch (e) {
          const retry = !(e instanceof CollectError) || e.retry;
          const attempts = item.attempts + 1;
          await outbox.update(item.client_submission_id, {
            status: retry ? "waiting" : "error",
            attempts,
            next_try_at: retry ? Date.now() + backoffMs(attempts) : Infinity,
            error: e instanceof Error ? e.message : "send failed",
          });
          if (e instanceof CollectError && e.status === 401) setRefused(e.message);
        }
        await reload();
      }
    } finally {
      syncing.current = false;
    }
  }, [access, reload]);

  useEffect(() => {
    queueMicrotask(() => void reload());
    const up = () => (setOnline(true), void sync());
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    const timer = window.setInterval(() => void sync(), SYNC_EVERY_MS);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      window.clearInterval(timer);
    };
  }, [sync, reload]);

  const contributor = session?.contributors.find((c) => c.code === code) ?? null;
  const tz = session?.project.timezone ?? DEFAULT_TZ;
  const waiting = items.filter((i) => i.status === "waiting" || i.status === "syncing").length;
  const shown = viewing ? items.find((i) => i.client_submission_id === viewing) ?? null : null;

  function choose(next: string) {
    store.set(CONTRIBUTOR_KEY, next);
    setCode(next);
    setPicking(false);
  }

  if (!access || !session || !device) {
    return <AccessGate refused={refused} loading={Boolean(access) && !refused} onPasscode={(p) => (setRefused(null), setAccess({ passcode: p }))} />;
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[560px] flex-col gap-4 px-4 pt-3 pb-10">
      <Glass as="header" className="glass-tint sticky top-2 z-20 flex items-center gap-3 rounded-2xl px-3.5 py-2.5">
        <span className="logo flex-none" aria-hidden />
        <div className="min-w-0 flex-1" data-testid="contributor">
          {contributor ? (
            <>
              <p className="truncate text-[13.5px] font-semibold">
                <span className="font-mono">{contributor.code}</span> {contributor.display_name}
              </p>
              <p className="truncate text-[12px] text-muted">{contributor.area} · {contributor.kind}</p>
            </>
          ) : (
            <p className="text-[13.5px] font-semibold">Field QA · Collect</p>
          )}
        </div>
        <SyncPill online={online} waiting={waiting} syncing={items.some((i) => i.status === "syncing")} />
      </Glass>

      {refused && session && <p className="rounded-lg border border-crit/40 px-3 py-2 text-[13px] text-crit" role="alert">{refused}</p>}

      {!contributor || picking ? (
        <ContributorPicker session={session} current={code} onChoose={choose} onCancel={contributor ? () => setPicking(false) : undefined} />
      ) : shown ? (
        <ResultScreen item={shown} tz={tz} onNew={() => setViewing(null)} />
      ) : (
        <>
          <CollectForm
            key={contributor.code}
            contributor={contributor}
            session={session}
            device={device}
            onSaved={async (item) => {
              await outbox.put(item);
              await reload();
              setViewing(item.client_submission_id);
              void sync();
            }}
          />
          <div className="flex items-center justify-between text-[12px] text-muted">
            <span className="font-mono">{device}</span>
            <button type="button" onClick={() => setPicking(true)} className="btn btn-sm btn-ghost" data-testid="switch-contributor">
              Switch contributor
            </button>
          </div>
          {items.length > 0 && <History items={items} tz={tz} onOpen={setViewing} />}
        </>
      )}
      {session.expires_at && (
        <p className="text-center text-[11.5px] text-faint">QR access until {fmtTime(new Date(session.expires_at * 1000).toISOString(), tz)} (Kisumu time)</p>
      )}
    </div>
  );
}

function SyncPill({ online, waiting, syncing }: { online: boolean; waiting: number; syncing: boolean }) {
  const [label, tone] = !online
    ? [`Offline${waiting ? ` · ${waiting} waiting` : ""}`, "st-warn"]
    : syncing
      ? ["Syncing", "st-info"]
      : waiting
        ? [`${waiting} waiting`, "st-warn"]
        : ["Online", "st-ok"];
  return (
    <span className={`st ${tone} flex-none rounded-full border border-line-strong px-2.5 py-1`} data-testid="sync-pill" aria-live="polite">
      <span>{label}</span>
    </span>
  );
}

function AccessGate({ refused, loading, onPasscode }: { refused: string | null; loading: boolean; onPasscode: (p: string) => void }) {
  const [value, setValue] = useState("");
  if (loading) return <p className="p-6 text-center text-muted">Opening the collect page…</p>;
  return (
    <div className="mx-auto flex min-h-screen max-w-[420px] flex-col justify-center gap-4 px-5">
      <div className="flex items-center gap-2.5 font-display font-semibold">
        <span className="logo" aria-hidden /> Field QA · Collect
      </div>
      <h1 className="text-[22px] font-semibold">Scan the QR code to start</h1>
      <p className="text-muted">
        This page is for phones in the demo. Open it from the QR code in the dashboard&apos;s demo controls, or enter the demo
        passcode.
      </p>
      {refused && <p className="text-[13px] text-crit" role="alert" data-testid="refused">{refused}</p>}
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (value.trim()) onPasscode(value.trim());
        }}
        className="flex gap-2"
      >
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Demo passcode" className="input font-mono" autoComplete="off" />
        <button type="submit" className="btn btn-primary">Open</button>
      </form>
    </div>
  );
}

function ContributorPicker({ session, current, onChoose, onCancel }: {
  session: CollectSession;
  current: string | null;
  onChoose: (code: string) => void;
  onCancel?: () => void;
}) {
  const groups = [
    { title: "Enumerators", people: session.contributors.filter((c) => c.kind === "enumerator") },
    { title: "Participants", people: session.contributors.filter((c) => c.kind === "participant") },
  ];
  return (
    <Section title="Who is collecting on this phone?" aria-label="Who is collecting" bodyClassName=""
      actions={onCancel && <button type="button" onClick={onCancel} className="btn btn-sm btn-ghost">Cancel</button>}>
      {current && (
        <p className="px-4 pt-3 text-[12.5px] text-warn">
          Switching contributor on this phone is a real signal: shared device will see two accounts.
        </p>
      )}
      {groups.map((g) => (
        <div key={g.title} className="px-4 py-3">
          <h3 className="mb-2 text-[12px] font-medium text-muted">{g.title}</h3>
          <div className="grid grid-cols-2 gap-1.5">
            {g.people.map((c) => (
              <button key={c.code} type="button" onClick={() => onChoose(c.code)} aria-pressed={c.code === current}
                className={`rounded-lg border px-2.5 py-2 text-left text-[12.5px] ${c.code === current ? "border-accent bg-accent-soft" : "border-line hover:bg-hover"}`}>
                <span className="font-mono">{c.code}</span> {c.display_name}
                <span className="block text-[11.5px] text-muted">{c.area}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </Section>
  );
}

function CollectForm({ contributor, session, device, onSaved }: {
  contributor: CollectContributor;
  session: CollectSession;
  device: string;
  onSaved: (item: OutboxItem) => Promise<void>;
}) {
  const openedAt = useRef(0);
  const [source, setSource] = useState<string | null>(null);
  const [satisfaction, setSatisfaction] = useState<(number | null)[]>(Array(8).fill(null));
  const [openText, setOpenText] = useState("");
  const [note, setNote] = useState<VoiceNote | null>(null);
  const [place, setPlace] = useState<"new" | "same">("new");
  const [useGps, setUseGps] = useState(false);
  const [minutes, setMinutes] = useState(DEFAULT_MINUTES);
  const [realTime, setRealTime] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    openedAt.current = Date.now();
  }, []);

  const ring = useMemo(
    () => session.areas.find((a) => a.id === contributor.area_id)?.boundary?.coordinates[0] ?? null,
    [session, contributor],
  );
  const missing = [!source && "the water source", satisfaction.some((v) => v == null) && "all 8 satisfaction answers"].filter(Boolean);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (missing.length) return setError(`Answer ${missing.join(" and ")} first.`);
    setSaving(true);
    setError(null);
    try {
      let fix: Fix;
      if (useGps) fix = await realGps();
      else if (place === "same" && contributor.last_point) fix = sameSpot(contributor.last_point);
      else if (ring) fix = newHousehold(ring);
      else throw new Error("this contributor has no area to place a household in");
      const now = phoneNow(); // the phone's clock, which a demo control can set 3 h back
      const elapsed = Math.max(60, Math.round((Date.now() - openedAt.current) / 1000));
      const id = `phone-${crypto.randomUUID()}`;
      await onSaved({
        client_submission_id: id,
        body: {
          contributor_code: contributor.code,
          device_id: device,
          client_submission_id: id,
          captured_at: now.toISOString(), // the phone's clock, at submit
          duration_sec: realTime ? elapsed : minutes * 60,
          lat: fix.lat,
          lng: fix.lng,
          gps_accuracy_m: fix.accuracy_m,
          answers: { water_source: source, satisfaction, open_text: openText.trim() },
          voice_transcript: null,
          source: "live",
        },
        audio: note?.blob ?? null,
        audio_type: note?.type ?? null,
        voice_note_path: null,
        status: "waiting",
        attempts: 0,
        next_try_at: 0,
        saved_at: now.toISOString(),
        synced_at: null,
        result: null,
        error: null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not save");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Interview">
      <Section title="Main water source">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {Object.entries(SOURCE_LABEL).map(([key, label]) => (
            <button key={key} type="button" onClick={() => setSource(key)} aria-pressed={source === key} data-testid={`source-${key}`}
              className={`min-h-12 rounded-xl border px-3.5 py-3 text-left text-[14.5px] ${source === key ? "border-accent bg-accent-soft text-ink" : "border-line text-ink-2 hover:bg-hover"}`}>
              {label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Satisfaction" summary="1 very dissatisfied · 5 very satisfied">
        <div className="flex flex-col gap-2">
          {ITEMS.map((item, i) => (
            <div key={item} className="flex items-center gap-2">
              <span className="w-[108px] flex-none text-[13px] text-ink-2">{item}</span>
              <div className="grid flex-1 grid-cols-5 gap-1.5" role="radiogroup" aria-label={item}>
                {[1, 2, 3, 4, 5].map((v) => (
                  <button key={v} type="button" role="radio" aria-checked={satisfaction[i] === v} aria-label={`${item} ${v}`}
                    onClick={() => setSatisfaction((s) => s.map((x, j) => (j === i ? v : x)))}
                    className={`h-10 rounded-lg border font-mono text-[14px] ${satisfaction[i] === v ? "border-accent bg-accent-soft text-ink" : "border-line text-muted"}`}>
                    {v}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Biggest challenge getting water">
        <textarea rows={3} value={openText} onChange={(e) => setOpenText(e.target.value)} className="input min-h-20"
          placeholder="In the respondent's words" aria-label="Biggest challenge getting water" />
      </Section>

      <Section title="Voice note">
        <Recorder note={note} onChange={setNote} />
      </Section>

      <Section title="Location" summary={useGps ? "Real GPS: outside Kisumu, outside area fires" : "Simulated: you're not in Kisumu"}>
        {!useGps && (
          <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Simulated location">
            {([["new", "A new household in my area"], ["same", "Same spot as my last interview"]] as const).map(([key, label]) => (
              <button key={key} type="button" role="radio" aria-checked={place === key} onClick={() => setPlace(key)}
                disabled={key === "same" && !contributor.last_point}
                className={`rounded-lg border px-3 py-2.5 text-left text-[13px] ${place === key ? "border-accent bg-accent-soft text-ink" : "border-line text-ink-2"}`}>
                {label}
              </button>
            ))}
          </div>
        )}
        <label className={`${useGps ? "" : "mt-3"} flex items-center gap-2 text-[13px]`}>
          <input type="checkbox" checked={useGps} onChange={(e) => setUseGps(e.target.checked)} data-testid="real-gps" /> Use my real GPS
        </label>
      </Section>

      <DemoControls>
        <div>
          <p className="text-[13px] font-medium text-ink">Interview length</p>
          <p className="mb-2 text-[12px] text-muted">Real interviews take about 25 minutes; a demo takes one.</p>
          <div className="flex items-center gap-3">
            <input type="number" min={1} max={180} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} disabled={realTime}
              className="input w-24 font-mono" aria-label="Interview length in minutes" />
            <span className="text-[13px] text-muted">minutes</span>
          </div>
          <label className="mt-2 flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={realTime} onChange={(e) => setRealTime(e.target.checked)} /> Use real elapsed time (since this form opened)
          </label>
        </div>
      </DemoControls>

      {error && <p className="text-[13px] text-crit" role="alert">{error}</p>}
      <button type="submit" disabled={saving} className="btn btn-primary min-h-12 justify-center text-[15px]" data-testid="submit">
        {saving ? "Saving…" : "Submit interview"}
      </button>
    </form>
  );
}

/**
 * Demo controls, closed unless the clock is off: the interview length (a demo takes a minute, not 25), and the
 * phone's clock set back 3 h as a fabricator might (clock_skew fires on the next sync).
 */
function DemoControls({ children }: { children: React.ReactNode }) {
  const [off, setOff] = useState(false);
  const [shown, setShown] = useState("");
  useEffect(() => {
    const tick = () => {
      setOff(clockOffsetMinutes() !== 0);
      setShown(phoneNow().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
    };
    tick();
    const timer = window.setInterval(tick, 15_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <Section title="Demo controls" collapsible defaultOpen={false} storeKey="collect-demo"
      summary={off ? "phone clock 3 h behind" : "interview length, phone clock"} data-testid="demo-controls" bodyClassName="flex flex-col gap-4 p-4">
      {children}
      <div>
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={off}
          data-testid="clock-off"
          onChange={(e) => {
            setClockOffsetMinutes(e.target.checked ? CLOCK_OFF_MINUTES : 0);
            setOff(e.target.checked);
            setShown(phoneNow().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
          }}
        />
        Phone clock off by 3 h
      </label>
      <p className="mt-1.5 text-[12px] text-muted">
        The phone&apos;s clock reads <span className="font-mono text-ink-2">{shown}</span>
        {off ? ", 3 hours behind: interviews and syncs report that time, and the clock-skew check fires." : "."}
      </p>
      </div>
    </Section>
  );
}

function History({ items, tz, onOpen }: { items: OutboxItem[]; tz: string; onOpen: (id: string) => void }) {
  return (
    <Section title="This phone's interviews" aria-label="This phone's interviews" bodyClassName="">
      <ul>
        {[...items].reverse().slice(0, 8).map((i) => (
          <li key={i.client_submission_id}>
            <button type="button" onClick={() => onOpen(i.client_submission_id)} className="flex w-full items-center justify-between gap-2 border-b border-line px-4 py-2.5 text-left text-[13px] hover:bg-hover">
              <span className="font-mono text-muted">{fmtTime(i.saved_at, tz)} · {String(i.body.contributor_code)}</span>
              <span className={`st ${i.status === "synced" ? (i.result?.band === "flagged" ? "st-crit" : "st-ok") : i.status === "error" ? "st-crit" : "st-warn"}`}>
                <span>{i.status === "synced" ? (i.result?.band === "flagged" ? "Flagged" : "Synced") : i.status === "error" ? "Not sent" : "Waiting"}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
