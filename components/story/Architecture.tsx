"use client";

import Link from "next/link";

import { Glass } from "@/components/ui/Glass";
import { msec, pct, secs, useStory, type Story } from "@/lib/story";

type Box = { title: string; body: string; num: string; label: string };

function flow(s: Story | null): { title: string; boxes: Box[] }[] {
  const m = s?.measured;
  const h = s?.headline?.held_out;
  return [
    {
      title: "Ingest: the rules' result before the phone screen changes",
      boxes: [
        { title: "Phone · /collect", body: "Offline-first: every interview goes to an IndexedDB outbox first; a retry reuses its client id.", num: secs(m?.phone.rules_s), label: "rules result after submit" },
        { title: "FastAPI on Vercel", body: "One Python 3.12 function in Montréal (yul1), next to the database.", num: msec(m?.ingest.p50_ms), label: `ingest p50 · p95 ${msec(m?.ingest.p95_ms)}` },
        { title: "Supabase Postgres", body: "ingest_begin leases every affected contributor and device and inserts idempotently; ingest_commit writes fenced.", num: msec(m?.ingest.api_p50_ms), label: "inside the API, p50" },
        { title: "Python engine", body: "Ten deterministic checks; every result carries evidence and the engine version.", num: pct(h?.recall), label: "held-out recall" },
      ],
    },
    {
      title: "Model work: queued after the commit, never awaited",
      boxes: [
        { title: "ai_jobs", body: "The database posts each new job to the API (pg_net); a cron sweep re-sends a lost one after 30 s.", num: String(s?.spend_now?.all_time_jobs ?? m?.spend.jobs ?? "…"), label: "jobs logged with their cost" },
        { title: "ElevenLabs · Claude", body: "Scribe transcribes, a Haiku-class model judges meaning, a Sonnet-class model writes the brief.", num: secs(m?.phone.verdict_s), label: `verdict after submit · transcript ${secs(m?.phone.transcript_s)}` },
        { title: "Realtime", body: "A verdict lands as an input; the submission is rescored on the same leased path.", num: msec(m?.realtime?.p50_ms), label: "insert to screen, p50" },
        { title: "Dashboard", body: "Refreshes on events; polls every 3 s only while the socket is down.", num: pct(h?.precision), label: "of flags are fabricated" },
      ],
    },
  ];
}

function callouts(s: Story | null) {
  const r = s?.hard?.rules.combined;
  const ra = s?.hard?.rules_ai.combined;
  return [
    { title: "Rules first", body: "Every check is plain code with evidence a reviewer can read. Same input, same score, every time." },
    {
      title: "AI as an input, not the judge",
      body: `A verdict is stored and a check reads it; with no verdict the rule stands. On hard mode it lifts recall from ${pct(r?.recall)} to ${pct(ra?.recall)}.`,
    },
    {
      title: "Corroboration-only signals",
      body: "Same spot, a copy only the model sees, a skewed phone clock and a near-boundary GPS miss weigh 1.5, under the 2.0 review bar: they flag only with another signal.",
    },
    {
      title: "Two-call ingest, healing retries",
      body: "Leases on everything an arrival can change, a fenced commit, and a retry that heals a row a crash left unscored.",
    },
  ];
}

/** /architecture: the system on one screen, each box with one measured number, and the four trade-offs. */
export function Architecture() {
  const { story, error } = useStory();
  const m = story?.measured;
  return (
    <main className="landing min-h-screen">
      <div className="landing-glow" aria-hidden />
      <div className="intro max-w-[1240px]">
        <Glass as="header" className="introbar">
          <div className="brand">
            <span className="logo" aria-hidden />
            Field QA Copilot
          </div>
          <nav className="flex gap-2">
            <Link href="/pitch" className="btn btn-ghost">Pitch</Link>
            <Link href="/app" className="btn btn-ghost">Open the app</Link>
          </nav>
        </Glass>

        <section className="mt-10">
          <h1 className="text-[30px] font-semibold tracking-tight">How it works</h1>
          <p className="mt-2 max-w-[70ch] text-muted">
            A phone syncs an interview; the rules score it at once; model work follows without holding anything up; every screen
            updates as it lands.
          </p>
        </section>

        {error && <p className="mt-6 text-crit">Couldn&apos;t load the numbers: {error}</p>}

        <div className="mt-8 flex flex-col gap-7" data-testid="architecture">
          {flow(story).map((row) => (
            <section key={row.title} aria-label={row.title}>
              <h2 className="mb-2.5 font-mono text-[11.5px] tracking-wide text-accent-ink uppercase">{row.title}</h2>
              <div className="grid items-stretch gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
                {row.boxes.map((box, i) => (
                  <div key={box.title} className="contents">
                    <div className="panel flex flex-col p-4">
                      <h3 className="text-[14px] font-semibold">{box.title}</h3>
                      <p className="mt-1.5 flex-1 text-[12.5px] leading-snug text-muted">{box.body}</p>
                      <p className="mt-3 font-mono text-[22px] text-ink">{box.num}</p>
                      <p className="text-[11.5px] text-faint">{box.label}</p>
                    </div>
                    {i < row.boxes.length - 1 && (
                      <span className="hidden self-center text-[18px] text-faint md:block" aria-hidden>→</span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <section className="how mt-9 lg:grid-cols-4" aria-label="Trade-offs">
          {callouts(story).map((c, i) => (
            <div key={c.title}>
              <span className="n">0{i + 1} · Trade-off</span>
              <h2>{c.title}</h2>
              <p>{c.body}</p>
            </div>
          ))}
        </section>

        <footer className="foot">
          Numbers from the repository, never typed: held-out seeds {story?.headline?.held_out_seeds.at(0)}–
          {story?.headline?.held_out_seeds.at(-1)} (data/eval/headline.json), hard mode seeds {story?.hard?.seeds.join(", ")}{" "}
          (hard.json), and production measured {m ? new Date(m.measured_at).toISOString().slice(0, 10) : "…"} with {m?.ingest.n}{" "}
          ingests and {m?.phone.n} phone interviews (measurements.json).
        </footer>
      </div>
    </main>
  );
}
