import type { Band, CheckKey, ContributorStatus, Hotspot } from "./types";

export const CHECK_ORDER: CheckKey[] = [
  "too_fast",
  "same_spot",
  "copied_text",
  "straight_lining",
  "voice_vs_form",
  "off_hours",
  "shared_device",
  "burst",
  "outside_area",
  "clock_skew",
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
  outside_area: "outside area",
  clock_skew: "clock skew",
};

/** Check names for chips and card titles (sentence case, as in the prototype). */
export const CHECK_TITLE: Record<CheckKey, string> = {
  too_fast: "Too fast",
  same_spot: "Same spot",
  copied_text: "Copied text",
  straight_lining: "Straight-lining",
  voice_vs_form: "Voice vs form",
  off_hours: "Off hours",
  shared_device: "Shared device",
  burst: "Burst",
  outside_area: "Outside area",
  clock_skew: "Clock skew",
};

/** "What it looks for", for the detectors table. */
export const CHECK_DESCRIPTION: Record<CheckKey, string> = {
  too_fast: "Shorter than a real visit takes",
  same_spot: "Several interviews at one location, one day",
  copied_text: "Open answer nearly identical to another",
  straight_lining: "All 8 satisfaction items the same, or a two-value zig-zag",
  voice_vs_form: "Voice note names a different water source",
  off_hours: "Captured between 21:00 and 06:00",
  shared_device: "One phone submitting for several accounts",
  burst: "Many submissions inside one hour",
  outside_area: "GPS point outside the assigned area, beyond GPS error",
  clock_skew: "Phone clock more than 5 minutes off the server's",
};

/** Checks whose evidence is strongest get the red card edge. */
export const CHECK_STRONG: ReadonlySet<CheckKey> = new Set<CheckKey>(["same_spot", "copied_text", "shared_device"]);

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
  outside_area: "call them about where these interviews happened; the GPS is outside their assigned area",
  clock_skew: "check the phone's clock with them; its times are off, so night work can look like daytime",
};

export const SOURCE_LABEL: Record<string, string> = {
  piped_home: "Piped to home",
  public_tap: "Public tap / kiosk",
  borehole: "Borehole",
  vendor: "Water vendor",
  river: "River",
};

/** The theme's colour tokens (app/globals.css), for inline styles and SVG. MapLibre and canvas cannot
 * read var(): they resolve the token with cssColor (lib/theme.ts). */
export const COLORS = {
  accent: "var(--color-accent)",
  ok: "var(--color-ok)",
  warn: "var(--color-warn)",
  crit: "var(--color-crit)",
  pass: "var(--color-pass)",
  muted: "var(--color-muted)",
  faint: "var(--color-faint)",
  ink: "var(--color-ink)",
};

/** Map and list colour: passed grey, flagged amber, score >= 5 red. */
export function scoreColor(score: number, band: Band): string {
  if (score >= 5) return COLORS.crit;
  if (band === "flagged") return COLORS.warn;
  return COLORS.pass;
}

/** Score tag variant: red at 5+, amber when flagged, plain otherwise. */
export function scoreClass(score: number, band: Band): string {
  return score >= 5 ? "score score-crit" : band === "flagged" ? "score score-warn" : "score";
}

export const STATUS_LABEL: Record<ContributorStatus, string> = { investigate: "Investigate", watch: "Watch", ok: "OK" };
export const STATUS_CLASS: Record<ContributorStatus, string> = { investigate: "st-crit", watch: "st-warn", ok: "st-ok" };

export function statusColor(status: ContributorStatus): string {
  return status === "investigate" ? COLORS.crit : status === "watch" ? COLORS.warn : COLORS.ok;
}

// Tie-break when two checks fired equally often. Shared device and same spot
// come first: they point at a specific place or phone to verify. E07's
// same-spot interviews were also logged in bursts (23 each), and same spot is
// the finding a field lead can act on.
const TIE_ORDER: CheckKey[] = [
  "shared_device",
  "same_spot",
  "outside_area",
  "burst",
  "copied_text",
  "voice_vs_form",
  "straight_lining",
  "off_hours",
  "clock_skew",
  "too_fast",
];

/** Checks by how often they fired for a contributor, most first, ties by TIE_ORDER. */
export function rankChecks(checks: Partial<Record<CheckKey, number>>): [CheckKey, number][] {
  return (Object.entries(checks) as [CheckKey, number][]).sort(
    (a, b) => b[1] - a[1] || TIE_ORDER.indexOf(a[0]) - TIE_ORDER.indexOf(b[0]),
  );
}

/**
 * A contributor's main signal: the check that fired most often for them.
 * The contributors table, the brief and the hotspot cards all use this.
 */
export function mainSignal(checks: Partial<Record<CheckKey, number>>): CheckKey | null {
  return rankChecks(checks)[0]?.[0] ?? null;
}

/**
 * The check to lead with for one submission: its contributor's main signal when that fired on it, else the
 * fired check that ranks first (TIE_ORDER). The queue's list chip and its opened evidence row use this.
 */
export function submissionMainSignal(fired: CheckKey[], contributorChecks?: Partial<Record<CheckKey, number>>): CheckKey | null {
  const main = contributorChecks ? mainSignal(contributorChecks) : null;
  if (main && fired.includes(main)) return main;
  return rankChecks(Object.fromEntries(fired.map((k) => [k, 1]))).at(0)?.[0] ?? null;
}

/** Each contributor's largest hotspot (some contributors have more than one pile). */
export function biggestHotspots(hotspots: Hotspot[]): Map<string, Hotspot> {
  const out = new Map<string, Hotspot>();
  for (const h of hotspots) {
    const current = out.get(h.contributor_code);
    if (!current || h.count > current.count) out.set(h.contributor_code, h);
  }
  return out;
}
