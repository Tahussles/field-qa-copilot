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
          <span className="badge">
            <b>Prototype</b> Built for community data collection teams
          </span>
          <h1>Catch fabricated field data before it reaches the analysis.</h1>
          <p>
            Rewards per submission invite invented ones. The copilot checks every interview as it arrives and hands reviewers a
            short, explained list.
          </p>
          <div className="cta">
            <Link href="/app" className="btn btn-primary">
              Open the app
            </Link>
            <Glass as={Link} href="/app/detectors" className="btn btn-glass">
              See how it is scored
            </Glass>
          </div>
        </section>

        <Stage />

        <section className="how" aria-label="How it works">
          <div>
            <span className="n">01 · Check</span>
            <h2>Ten checks on every interview</h2>
            <p>Cheap, explainable rules, run the moment data syncs.</p>
            <CheckList />
          </div>
          <div>
            <span className="n">02 · Explain</span>
            <h2>Evidence, not a black box</h2>
            <p>
              Each flag shows why: the cluster on a map, the two copied answers side by side, the voice note that contradicts
              the form.
            </p>
          </div>
          <div>
            <span className="n">03 · Decide</span>
            <h2>A human makes every call</h2>
            <p>
              Reviewers approve, reject or send a supervisor to back-check. A morning brief tells the lead researcher who to
              look at first.
            </p>
          </div>
        </section>
        <footer className="foot">
          Synthetic data with fraud planted on purpose, so every check can be scored. Prototype by Taha Hussain.
          <br />
          Prototype built for Poket · not an official Poket product.
        </footer>
      </div>
      <OpenOnEnter />
    </main>
  );
}
