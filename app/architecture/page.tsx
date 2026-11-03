import type { Metadata } from "next";

import { Architecture } from "@/components/story/Architecture";

export const metadata: Metadata = {
  title: "Architecture · Field QA Copilot",
  description: "The system on one screen: ingest, the engine, model work and Realtime, with measured numbers.",
};

export default function ArchitecturePage() {
  return <Architecture />;
}
