"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { msec, pct, secs, usd, useStory, type Story } from "@/lib/story";

const TITLES = ["Problem", "What it does", "How it works", "Proof", "What's next"];

function Stat({ value, label, testid }: { value: string; label: ReactNode; testid?: string }) {
  return (
    <div className="panel p-5" data-testid={testid}>
      <p className="font-mono text-[40px] leading-none text-ink">{value}</p>
      <p className="mt-2 text-[13.5px] text-muted">{label}</p>
    </div>
  );
}

function slides(s: Story | null): ReactNode[] {
  const d = s?.headline?.demo_seed;
  const h = s?.headline?.held_out;
  const r = s?.hard?.rules.combined;
  const ra = s?.hard?.rules_ai.combined;
  const m = s?.measured;
  const spend = s?.spend_now;
  return [
    <>
      <h2>Rewards invite fakes.</h2>
      <p>
        Contributors are paid per submission, so a few invent them: forms filled in at a tea shop, answers copied from
        yesterday, one phone running several accounts, interviews written at night. The researcher finds out weeks later, if at
        all.
      </p>
      <p className="text-faint">
        The demo wave: {d?.submissions?.toLocaleString("en-US") ?? "…"} interviews in Kisumu, {d?.fabricated ?? "…"} of them
        fakes planted on purpose so every catch can be scored.
      </p>
    </>,
    <>
      <h2>It checks every interview as it syncs.</h2>
      <ul>
        <li>Ten cheap, explainable checks score each submission the moment it arrives.</li>
        <li>Every flag shows its evidence: the cluster on the map, the copied answers side by side, the sentence that contradicts the form.</li>
        <li>Flagged work goes to a queue where a person approves, rejects or sends a back-check.</li>
        <li>A morning brief tells the lead researcher who to look at first.</li>
      </ul>
    </>,
    <>
      <h2>Rules first; the model is an input.</h2>
      <p>
        A phone posts the interview; two database calls lease, score and commit it in {msec(m?.ingest.p50_ms)} (p50). Speech to
        text and meaning checks run after, never holding the phone up, and land as verdicts a rule reads.
      </p>
      <p>
        <Link href="/architecture" className="text-accent-ink hover:underline">
          See the architecture →
        </Link>
      </p>
    </>,
    <>
      <h2>Proof, on data it was never tuned on.</h2>
      <div className="mt-5 grid gap-3 md:grid-cols-2" data-testid="proof">
        <Stat value={pct(h?.recall, 0)} label={<>of fabricated interviews caught (held-out recall {pct(h?.recall)})</>} testid="proof-recall" />
        <Stat value={pct(h?.precision, 0)} label={<>of flags are fabricated (held-out precision {pct(h?.precision)})</>} testid="proof-precision" />
        <Stat
          value={`${pct(r?.recall, 0)} → ${pct(ra?.recall, 0)}`}
          label={<>recall on hard mode, rules only → rules + AI (precision {pct(r?.precision)} → {pct(ra?.precision)})</>}
        />
        <Stat
          value={`${secs(m?.phone.rules_s)} · ${secs(m?.phone.verdict_s)}`}
          label={<>rules result · model verdict after a phone submits (ingest p50 {msec(m?.ingest.p50_ms)})</>}
        />
      </div>
      <p className="mt-4 text-faint">
        Model spend so far {usd(spend?.all_time_usd)} for {spend?.all_time_jobs?.toLocaleString("en-US") ?? "…"} jobs. Held-out seeds{" "}
        {s?.headline?.held_out_seeds.at(0)}–{s?.headline?.held_out_seeds.at(-1)}; hard mode rewrites three fraud actors to dodge the
        rules (seeds {s?.hard?.seeds.join(", ")}).
      </p>
    </>,
    <>
      <h2>What&apos;s next</h2>
      <ul>
        <li>
          <b>A monotonic clock check.</b> A phone that sets its clock back and puts it right before syncing leaves no skew; the
          time since boot, sent with every form, would.
        </li>
        <li>
          <b>Reward-gaming checks.</b> Submissions bunched just under a payout threshold, or at the end of a reward period.
        </li>
        <li>
          <b>Plug into the existing verification queue.</b> Send flags with their evidence to the queue reviewers already use,
          and learn from their decisions.
        </li>
      </ul>
    </>,
  ];
}

/** /pitch: five slides, arrow keys to move, the numbers from /api/py/story. #4 opens slide 4. */
export function Pitch() {
  const router = useRouter();
  const { story } = useStory();
  const [index, setIndex] = useState(0);
  const deck = slides(story);

  const go = useCallback(
    (to: number) => {
      const next = Math.max(0, Math.min(deck.length - 1, to));
      setIndex(next);
      window.history.replaceState(null, "", `#${next + 1}`);
    },
    [deck.length],
  );

  useEffect(() => {
    const fromHash = Number(window.location.hash.slice(1));
    if (fromHash >= 1 && fromHash <= TITLES.length) queueMicrotask(() => setIndex(fromHash - 1));
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(e.key)) go(index + 1);
      else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) go(index - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(deck.length - 1);
      else if (e.key === "Escape") router.push("/app");
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, go, deck.length, router]);

  return (
    <main className="landing flex min-h-screen flex-col">
      <div className="landing-glow" aria-hidden />
      <div className="relative z-10 mx-auto flex w-full max-w-[1100px] flex-1 flex-col px-6 py-8">
        <header className="flex items-center gap-3 text-[12.5px] text-muted">
          <span className="logo" aria-hidden />
          <span className="font-semibold text-ink">Field QA Copilot</span>
          <span className="ml-auto font-mono">
            {index + 1} / {deck.length} · {TITLES[index]}
          </span>
        </header>
        <section className="pitch-slide flex flex-1 flex-col justify-center" aria-live="polite" data-testid={`slide-${index + 1}`}>
          <span className="font-mono text-[12px] tracking-wide text-accent-ink uppercase">{TITLES[index]}</span>
          {deck[index]}
        </section>
        <footer className="flex items-center gap-3 text-[12px] text-faint">
          <div className="flex gap-1.5" role="tablist" aria-label="Slides">
            {TITLES.map((t, i) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={`Slide ${i + 1}: ${t}`}
                onClick={() => go(i)}
                className={`h-1.5 w-6 rounded-full ${i === index ? "bg-accent" : "bg-contrast/15 hover:bg-contrast/30"}`}
              />
            ))}
          </div>
          <span className="ml-auto">← → to move · Esc for the app</span>
        </footer>
      </div>
    </main>
  );
}
