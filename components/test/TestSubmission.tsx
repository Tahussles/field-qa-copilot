"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";

import { useAppData } from "@/components/app/AppData";
import { useWithPasscode } from "@/components/app/Passcode";
import { useToast } from "@/components/app/Toasts";
import { api } from "@/lib/api";
import { CHECK_TITLE, SOURCE_LABEL } from "@/lib/checks";
import { fmtScore, shortId } from "@/lib/format";
import type { IngestResponse, MapPoint } from "@/lib/types";

const SOURCES = Object.keys(SOURCE_LABEL);
const ITEMS = ["Reliability", "Distance", "Cost", "Quality", "Waiting", "Safety", "Hours", "Overall"];
const VARIED = [3, 2, 3, 4, 2, 3, 4, 3];

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
    apply: (f) => ({ ...f, minutes: 27, source: "public_tap", satisfaction: [...VARIED],
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
    satisfaction: [...VARIED],
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

  // Checked whenever all 8 match, so the Speeder preset shows up here too.
  const sameAll = form.satisfaction.every((v) => v === form.satisfaction[0]);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <section className="panel" aria-label="Test submission">
      <div className="ph">
        <h2>Send a test submission</h2>
        <span className="ph-caption">Runs through the same checks as the real data</span>
      </div>
      <p className="max-w-[76ch] px-4 pt-3.5 text-muted">
        A backup for the demo: this posts exactly what a phone would (source <span className="font-mono">live</span>), scores it with
        the engine, and shows up on the map and in the queue within a second. Try a preset, or fake one yourself.
      </p>
      <div className="flex flex-wrap gap-2 px-4 pt-3.5">
        {PRESETS.map((p) => (
          <button key={p.name} type="button" onClick={() => setForm((f) => p.apply(f))} className="btn btn-sm">
            {p.name} <span className="text-faint">· {p.note}</span>
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4 gap-y-3.5 p-4">
        <Field label="Enumerator">
          <select value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value, device: `demo-phone-${e.target.value}` }))} className="input">
            {(enumerators.length ? enumerators : [form.code]).map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Duration (minutes)">
          <input type="number" min={1} max={180} value={form.minutes} onChange={(e) => set("minutes", Number(e.target.value))} className="input" />
        </Field>
        <Field label={`Captured at (today, ${today ?? "…"})`}>
          <input type="time" value={form.time} onChange={(e) => set("time", e.target.value)} className="input" />
        </Field>
        <Field label="Main water source (form)">
          <select value={form.source} onChange={(e) => set("source", e.target.value)} className="input">
            {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
          </select>
        </Field>
        <Field label="Voice note transcript" full>
          <input type="text" value={form.transcript} onChange={(e) => set("transcript", e.target.value)} className="input" />
        </Field>
        <Field label="Biggest challenge getting water (open-ended)" full>
          <textarea rows={3} value={form.openText} onChange={(e) => set("openText", e.target.value)} className="input min-h-16 resize-y" />
        </Field>
        <label className="col-span-full flex items-center gap-2 text-ink">
          <input
            type="checkbox"
            checked={sameAll}
            onChange={(e) => set("satisfaction", e.target.checked ? Array(8).fill(3) : [...VARIED])}
          />
          Answer all 8 satisfaction questions with the same score
        </label>
        <details className="col-span-full -mt-1.5 text-[12px] text-muted">
          <summary className="w-max cursor-pointer select-none hover:text-ink">Adjust answers</summary>
          <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-8">
            {form.satisfaction.map((v, i) => (
              <label key={i} className="flex flex-col gap-1 text-[11px] font-normal text-faint">
                {ITEMS[i]}
                <input type="number" min={1} max={5} value={v} className="input"
                  onChange={(e) => set("satisfaction", form.satisfaction.map((x, j) => (j === i ? Number(e.target.value) : x)))} />
              </label>
            ))}
          </div>
        </details>
        <label className="col-span-full flex items-center gap-2 text-ink">
          <input type="checkbox" checked={form.nearLast} onChange={(e) => set("nearLast", e.target.checked)} />
          Place it at {form.code}&apos;s last interview spot {last ? "" : "(no previous location)"}
        </label>
        <div className="col-span-full flex flex-wrap gap-2">
          <button type="submit" disabled={sending || !last || !today} className="btn btn-primary">
            {sending ? "Scoring…" : "Send submission"}
          </button>
        </div>
      </form>

      <div className="px-4 pb-4" aria-live="polite">
        {result && (
          <div className={`card ${result.flagged ? "card-crit" : ""}`}>
            <h3>
              {shortId(result.id)} · score {fmtScore(result.score)} · {result.flagged ? "sent to the review queue" : "passed"}
            </h3>
            <p>
              {result.fired.length
                ? `Checks that fired: ${result.fired.map((f) => `${CHECK_TITLE[f.key]} (+${f.weight})`).join(", ")}.`
                : "No checks fired."}
              {result.changed.length > 0 &&
                ` This arrival flipped ${result.changed.length} earlier ${result.changed.length === 1 ? "submission" : "submissions"} to flagged.`}
              {result.timing_ms && ` Scored in ${result.timing_ms.total} ms.`}
            </p>
            <Link href={`/app/queue/${result.id}?status=all`} className="btn btn-sm">
              Open it in the queue
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <label className={`flex flex-col gap-[5px] text-[12px] font-medium text-muted ${full ? "col-span-full" : ""}`}>
      {label}
      {children}
    </label>
  );
}
