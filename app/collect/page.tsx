import type { Metadata, Viewport } from "next";
import { Suspense } from "react";

import { CollectApp } from "@/components/collect/CollectApp";

export const metadata: Metadata = {
  title: "Collect · Field QA Copilot",
  description: "The demo phone: record an interview and watch it checked as it syncs.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#08090a" };

/** The phone collect page: offline-first form, voice note, live result. Opened from the demo panel's QR code. */
export default function CollectPage() {
  return (
    <main className="relative min-h-screen">
      <div className="ambient" aria-hidden />
      <div className="relative z-10">
        <Suspense fallback={<p className="p-6 text-center text-muted">Opening the collect page…</p>}>
          <CollectApp />
        </Suspense>
      </div>
    </main>
  );
}
