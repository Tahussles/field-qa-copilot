// Formatting in the project's timezone (Africa/Nairobi for the demo).

export const DEFAULT_TZ = "Africa/Nairobi";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = tz + JSON.stringify(options);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...options });
    formatters.set(key, f);
  }
  return f;
}

export function fmtTime(iso: string, tz = DEFAULT_TZ): string {
  return formatter(tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

export function fmtDay(iso: string, tz = DEFAULT_TZ): string {
  return formatter(tz, { weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
}

export function fmtDateTime(iso: string, tz = DEFAULT_TZ): string {
  return `${fmtDay(iso, tz)}, ${fmtTime(iso, tz)}`;
}

/** "2026-10-30" (a local calendar date) -> "Thu 30 Oct". */
export function fmtLocalDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return formatter("UTC", { weekday: "short", day: "numeric", month: "short" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Local date (YYYY-MM-DD) of an instant in the project timezone. */
export function localDate(iso: string, tz = DEFAULT_TZ): string {
  return formatter(tz, { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)).split("/").reverse().join("-");
}

/** Hours since local midnight, e.g. 22.5 for 22:30. */
export function localHours(iso: string, tz = DEFAULT_TZ): number {
  const parts = formatter(tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h + m / 60;
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m ${String(rest).padStart(2, "0")}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function fmtPct(value: number | null | undefined, digits = 0): string {
  return value == null ? "—" : `${(value * 100).toFixed(digits)}%`;
}

/** Scores as the prototype shows them: 6, 3.5 (no trailing ".0"). */
export function fmtScore(score: number | null | undefined): string {
  return score == null ? "—" : String(Number(score.toFixed(1)));
}

/** "Oct 27": month first, as in the prototype's lists. */
export function fmtMonthDay(iso: string, tz = DEFAULT_TZ): string {
  const parts = formatter(tz, { month: "short", day: "numeric" }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")} ${get("day")}`;
}

/** "Oct 27, 14:26": the queue and evidence timestamp format. */
export function fmtStamp(iso: string, tz = DEFAULT_TZ): string {
  return `${fmtMonthDay(iso, tz)}, ${fmtTime(iso, tz)}`;
}

/** "S-3F9A": a short, readable handle for a submission id. */
/** "27/10": day and month only, for dense lists (the full stamp goes in a tooltip). */
export function fmtDayMonth(iso: string, tz = DEFAULT_TZ): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", timeZone: tz });
}

export function shortId(id: string): string {
  return `S-${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
