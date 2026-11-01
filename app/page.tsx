import Link from "next/link";

export default function Home() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="ambient" aria-hidden />
      <h1 className="relative font-display text-3xl font-semibold tracking-tight">Field QA Copilot</h1>
      <p className="relative max-w-md text-muted">
        Fabrication checks for field data submissions. The landing page is coming soon.
      </p>
      <Link
        href="/app"
        className="relative rounded-lg border border-line-strong bg-panel px-4 py-2 text-sm text-ink hover:bg-raised"
      >
        Open the dashboard
      </Link>
    </main>
  );
}
