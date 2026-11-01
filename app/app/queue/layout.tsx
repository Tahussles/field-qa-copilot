import { Suspense, type ReactNode } from "react";

import { QueueView } from "@/components/queue/QueueView";

// The queue lives in the layout so its list and filters survive moving between
// /app/queue/[id] selections. The pages below only carry the URL.
export default function QueueLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Suspense fallback={<p className="text-sm text-muted">Loading the queue…</p>}>
        <QueueView />
      </Suspense>
      {children}
    </>
  );
}
