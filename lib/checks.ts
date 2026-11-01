import type { Band, CheckKey, ContributorStatus } from "./types";

export const CHECK_ORDER: CheckKey[] = [
  "too_fast",
  "same_spot",
  "copied_text",
  "straight_lining",
  "voice_vs_form",
  "off_hours",
  "shared_device",
  "burst",
];

export const CHECK_LABEL: Record<CheckKey, string> = {
  too_fast: "too fast",
  same_spot: "same spot",
  copied_text: "copied text",
  straight_lining: "straight-lining",
  voice_vs_form: "voice vs form",
  off_hours: "off hours",
  shared_device: "shared device",
  burst: "burst",
};

export const CHECK_TITLE: Record<CheckKey, string> = {
  too_fast: "Finished too fast",
  same_spot: "Same spot as other interviews",
  copied_text: "Open answer copied",
  straight_lining: "All answers identical",
  voice_vs_form: "Voice note contradicts the form",
  off_hours: "Captured at night",
  shared_device: "Phone shared between accounts",
  burst: "Burst of submissions",
};

/** What a field lead should do about a contributor whose dominant signal is this check. */
export const CHECK_ACTION: Record<CheckKey, string> = {
  same_spot: "back-check three households in person and compare their GPS with the household list",
  too_fast: "shadow one interview tomorrow and compare timings",
  copied_text: "pull their open answers side by side and re-interview a sample",
  straight_lining: "shadow one interview; answers are not being read out",
  voice_vs_form: "listen to the voice notes and re-train on the water source question",
  off_hours: "ask about the late entries and back-check the night submissions",
  shared_device: "verify each account in person; several accounts are using one phone",
  burst: "hold their points and confirm the submissions with them directly",
};

export const SOURCE_LABEL: Record<string, string> = {
  piped_home: "Piped to home",
  public_tap: "Public tap / kiosk",
  borehole: "Borehole",
  vendor: "Water vendor",
  river: "River",
};

export const COLORS = {
  accent: "#7c84f8",
  ok: "#4cb782",
  warn: "#f0a23b",
  crit: "#eb5a57",
  pass: "#6b707a",
  muted: "#8a8f98",
  faint: "#5b606a",
  ink: "#f1f2f4",
};

/** Map and list colour: passed grey, flagged amber, score >= 5 red. */
export function scoreColor(score: number, band: Band): string {
  if (score >= 5) return COLORS.crit;
  if (band === "flagged") return COLORS.warn;
  return COLORS.pass;
}

export function statusColor(status: ContributorStatus): string {
  return status === "investigate" ? COLORS.crit : status === "watch" ? COLORS.warn : COLORS.ok;
}

// Tie-break when two checks fired equally often: the more specific evidence
// leads (a shared GPS fix or copied text says more than speed alone).
const SPECIFICITY: CheckKey[] = [
  "same_spot",
  "copied_text",
  "voice_vs_form",
  "shared_device",
  "straight_lining",
  "burst",
  "off_hours",
  "too_fast",
];

/** Checks by how often they fired, most first; the table and the brief share this order. */
export function rankChecks(checks: Partial<Record<CheckKey, number>>): [CheckKey, number][] {
  return (Object.entries(checks) as [CheckKey, number][]).sort(
    (a, b) => b[1] - a[1] || SPECIFICITY.indexOf(a[0]) - SPECIFICITY.indexOf(b[0]),
  );
}

export function dominantCheck(checks: Partial<Record<CheckKey, number>>): CheckKey | null {
  return rankChecks(checks)[0]?.[0] ?? null;
}
