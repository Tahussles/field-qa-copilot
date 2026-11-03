import type { Metadata } from "next";

import { Pitch } from "@/components/story/Pitch";

export const metadata: Metadata = {
  title: "Pitch · Field QA Copilot",
  description: "Five slides: the problem, what it does, how it works, proof and what's next.",
};

export default function PitchPage() {
  return <Pitch />;
}
