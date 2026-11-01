"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";

import { useAppData } from "@/components/app/AppData";
import { useWithPasscode } from "@/components/app/Passcode";
import { useToast } from "@/components/app/Toasts";
import { api } from "@/lib/api";
import { CHECK_TITLE, SOURCE_LABEL, scoreColor } from "@/lib/checks";
import { fmtDuration, fmtScore, shortId } from "@/lib/format";
import type { IngestResponse, MapPoint } from "@/lib/types";

const SOURCES = Object.keys(SOURCE_LABEL);
const ITEMS = ["Reliability", "Distance", "Cost", "Quality", "Waiting", "Safety", "Hours", "Overall"];

interface Form {
  code: string;
  device: string;
  minutes: number;
  time: string; // HH:MM, local, on the project's today
  source: string;
  satisfaction: number[];
  openText: string;
  transcript: string;
  nearLast: boolean;
}

const PRESETS: { name: string; note: string; apply: (f: Form) => Form }[] = [
  {
    name: "Typical interview",
    note: "Should pass",
    apply: (f) => ({ ...f, minutes: 27, source: "public_tap", satisfaction: [3, 2, 3, 4, 2, 3, 4, 3],
      openText: "The queue at the kiosk is long in the evenings, so my daughter fetches water before school.",
      transcript: "We fetch from the public tap near the market.", nearLast: false }),
  },
  {
    name: "Speeder",
    note: "too fast + straight-lining",
    apply: (f) => ({ ...f, minutes: 5, satisfaction: [4, 4, 4, 4, 4, 4, 4, 4], openText: "Water is a problem.", nearLast: false }),
  },
  {
    name: "Contradiction",
    note: "voice vs form",
    apply: (f) => ({ ...f, minutes: 24, source: "piped_home",
      transcript: "We don't have a tap, so we buy from the vendor with the handcart.", nearLast: false }),
  },
  {
    name: "Same spot again",
    note: "at their last location",
    apply: (f) => ({ ...f, minutes: 10, nearLast: true }),
  },
];

// Mid-morning on the project's today; capturedAt() never lets it run past the real clock.
const DEFAULT_TIME = "10:30";

export function TestSubmission() {
  const { overview, map } = useAppData();
  const withPasscode = useWithPasscode();
  const toast = useToast();
  const today = overview?.today.date;
  const enumerators = useMemo(() => (overview?.contributors ?? []).filter((c) => c.kind === "enumerator").map((c) => c.code).sort(), [overview]);
  const [form, setForm] = useState<Form>(() => ({
    code: "E03",
    device: "demo-phone-E03",
    minutes: 27,
    time: DEFAULT_TIME,
    source: "public_tap",
    satisfaction: [3, 2, 3, 4, 2, 3, 4, 3],
    openText: "The queue at the kiosk is long in the evenings, so my daughter fetches water before school.",
    transcript: "We fetch from the public tap near the market.",
    nearLast: false,
  }));
  const [result, setResult] = useState<IngestResponse | null>(null);
  const [sending, setSending] = useState(false);

  const last: MapPoint | undefined = useMemo(
    () => [...(map?.points ?? [])].filter((p) => p.code === form.code).sort((a, b) => b.captured_at.localeCompare(a.captured_at))[0],
    [map, form.code],
  );

  function capturedAt(): string | null {
    if (!today) return null;
    // Today in the project timezone (UTC+3 for Nairobi) at the chosen local time.
    const local = new Date(`${today}T${form.time}:00+03:00`);
    const latest = Date.now() - 60_000;
    return new Date(Math.min(local.getTime(), latest)).toISOString();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const captured = capturedAt();
    if (!captured || !last) return;
    const jitter = form.nearLast ? 0.00004 : 0.004;
    const body = {
      contributor_code: form.code,
      device_id: form.device,
      client_submission_id: `dashboard-${crypto.randomUUID()}`,
      captured_at: captured,
      duration_sec: form.minutes * 60,
      lat: Number((last.lat + (Math.random() - 0.5) * jitter).toFixed(6)),
      lng: Number((last.lng + (Math.random() - 0.5) * jitter).toFixed(6)),
      gps_accuracy_m: 8,
      answers: { water_source: form.source, satisfaction: form.satisfaction, open_text: form.openText },
      voice_transcript: form.transcript,
      source: "live",
    };
    setSending(true);
    try {
      const response = await withPasscode((code) => api.submit(code, body));
      if (response) {
        setResult(response);
        toast({ tone: response.flagged ? "flag" : "ok", title: `${shortId(response.id)} scored ${fmtScore(response.score)}` });
      }
    } catch (e) {
      toast({ tone: "error", title: "Submission failed", body: e instanceof Error ? e.message : undefined });
    } finally {
      setSending(false);
    }
  }

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <div className="mx-auto grid max-w-[1200px] gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
      <form onSubmit={submit} className="panel space-y-4 p-4" aria-label="Test submission">
        <div>
          <h2 className="font-display text-sm font-semibold">Send a submission through the live pipeline</h2>
          <p className="mt-1 text-[12.5px] text-muted">
            A backup for the demo: this posts exactly what a phone would (source <span className="font-mono">live</span>), scores it with
            the engine, and shows up on the map and in the queue within a second.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button key={p.name} type="button" onClick={() => setForm((f) => p.apply(f))}
              className="rounded-lg border border-line-strong bg-white/[0.03] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-white/[0.07]">
              <span className="text-ink">{p.name}</span> <span className="text-faint">· {p.note}</span>
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Enumerator">
            <select value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value, device: `demo-phone-${e.target.value}` }))} className="input">
              {(enumerators.length ? enumerators : [form.code]).map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Duration (min)">
            <input type="number" min={1} max={180} value={form.minutes} onChange={(e) => set("minutes", Number(e.target.value))} className="input" />
          </Field>
          <Field label={`Captured (today, ${today ?? "…"})`}>
            <input type="time" value={form.time} onChange={(e) => set("time", e.target.value)} className="input" />
          </Field>
          <Field label="Water source">
            <select value={form.source} onChange={(e) => set("source", e.target.value)} className="input">
              {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Satisfaction (1–5)">
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
            {form.satisfaction.map((v, i) => (
              <label key={i} className="text-[11px] text-faint">
                {ITEMS[i]}
                <input type="number" min={1} max={5} value={v} className="input mt-1"
                  onChange={(e) => set("satisfaction", form.satisfaction.map((x, j) => (j === i ? Number(e.target.value) : x)))} />
              </label>
            ))}
          </div>
        </Field>
        <Field label="Open answer">
          <textarea rows={2} value={form.openText} onChange={(e) => set("openText", e.target.value)} className="input" />
        </Field>
        <Field label="Voice transcript">
          <textarea rows={2} value={form.transcript} onChange={(e) => set("transcript", e.target.value)} className="input" />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[12.5px] text-muted">
            <input type="checkbox" checked={form.nearLast} onChange={(e) => set("nearLast", e.target.checked)} />
            At {form.code}&apos;s last location {last ? "" : "(no previous location)"}
          </label>
          <button type="submit" disabled={sending || !last || !today}
            className="ml-auto rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50">
            {sending ? "Scoring…" : "Submit"}
          </button>
        </div>
      </form>

      <section className="panel p-4" aria-label="Result" aria-live="polite">
        <h2 className="font-display text-sm font-semibold">Result</h2>
        {!result ? (
          <p className="mt-2 text-[13px] text-muted">Pick a preset or fill the form, then submit. The passcode is asked once.</p>
        ) : (
          <div className="mt-3 space-y-3 text-[13px]">
            <div className="flex items-center gap-3">
              <span className="font-mono text-ink">{shortId(result.id)}</span>
              <span className="rounded-md px-2 py-0.5 font-display font-semibold"
                style={{ color: scoreColor(result.score ?? 0, result.band ?? "clear"), background: `${scoreColor(result.score ?? 0, result.band ?? "clear")}1a` }}>
                {fmtScore(result.score)}
              </span>
              <span className="text-muted capitalize">{result.band}</span>
              <Link href={`/app/queue/${result.id}?status=all`} className="ml-auto text-accent hover:brightness-125">Open in queue →</Link>
            </div>
            <ul className="space-y-1">
              {result.fired.length ? result.fired.map((f) => (
                <li key={f.key} className="flex items-center gap-2">
                  <span className="dot bg-warn" aria-hidden /> {CHECK_TITLE[f.key]} <span className="font-mono text-faint">+{f.weight}</span>
                </li>
              )) : <li className="text-muted">No checks fired.</li>}
            </ul>
            {result.changed.length > 0 && (
              <p className="text-warn">This arrival flipped {result.changed.length} earlier {result.changed.length === 1 ? "submission" : "submissions"} to flagged.</p>
            )}
            {result.timing_ms && <p className="text-[11.5px] text-faint">Scored in {result.timing_ms.total} ms · duration {fmtDuration(form.minutes * 60)}</p>}
          </div>
        )}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[12px] text-muted">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}
