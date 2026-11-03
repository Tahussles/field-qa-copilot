"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/api";

/** On a preview deployment the API refuses every write (WRITES_ENABLED); say so once, up front. */
export function ReadOnlyBanner() {
  const [readOnly, setReadOnly] = useState(false);
  useEffect(() => {
    api
      .health()
      .then((h) => setReadOnly(h.writes === false))
      .catch(() => undefined);
  }, []);
  if (!readOnly) return null;
  return (
    <p className="panel mb-3 rounded-xl px-4 py-2.5 text-[13px] text-ink-2" role="status" data-testid="read-only">
      <b className="text-warn">Read-only preview.</b> This deployment shows the live data but cannot write: reviews,
      phone submissions, demo controls and AI jobs run on production only.
    </p>
  );
}
