import Link from "next/link";

import { OpenOnEnter } from "@/components/landing/OpenOnEnter";
import { CheckList } from "@/components/landing/CheckList";
import { Stage } from "@/components/landing/Stage";
import { Glass } from "@/components/ui/Glass";

/** The landing page: the prototype's #home view, with a stage that replays (or shows live) real submissions. */
export default function Home() {
  return (
    <main className="landing">
      <div className="landing-glow" aria-hidden />
      <div className="intro">
        <Glass as="header" className="introbar">
          <div className="brand">
            <span className="logo" aria-hidden />
            Field QA Copilot
          </div>
          <nav className="flex items-center gap-1">
            <Link href="/architecture" className="btn btn-ghost">
              How it works
            </Link>
            <Link href="/app" className="btn btn-ghost">
              Open the app <kbd className="kbd">↵</kbd>
            </Link>
          </nav>
        </Glass>

        <section className="hero">
          <span className="badge" title="Built for community data collection teams">
            <b>Prototype</b>
          </span>
          <h1>Catch fabricated field data before it reaches the analysis.</h1>
          <p>Every interview checked as it syncs; reviewers get a short, explained list.</p>
          <div className="cta">
            <Link href="/app" className="btn btn-primary">
              Open the app
            </Link>
            <Glass as={Link} href="/app/detectors" className="btn btn-glass">
              How it&apos;s scored
            </Glass>
          </div>
        </section>

        <Stage />

        <section className="how" aria-label="How it works">
          <div>
            <span className="n">01 · Check</span>
            <h2 title="Cheap, explainable rules, run the moment data syncs.">Ten checks on every interview</h2>
            <CheckList />
          </div>
          <div>
            <span className="n">02 · Explain</span>
            <h2 title="Each flag shows why: the cluster on a map, the copied answers side by side, the voice note that contradicts the form.">
              Evidence, not a black box
            </h2>
          </div>
          <div>
            <span className="n">03 · Decide</span>
            <h2 title="Reviewers approve, reject or send a back-check; the brief says who to look at first.">A human makes every call</h2>
          </div>
        </section>
        <footer className="foot" title="Synthetic data with fraud planted on purpose, so every check can be scored.">
          Synthetic data · by Taha Hussain · Prototype for Poket · not official
        </footer>
      </div>
      <OpenOnEnter />
    </main>
  );
}
