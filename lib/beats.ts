// The demo script's jump buttons, for pages that are already open: /app?beat=brief and
// /app?beat=hotspot&code=E07 on a fresh load, or this window event when the overview is showing.

export type Beat = { beat: "brief" } | { beat: "hotspot"; code: string };
const EVENT = "fqc:beat";

export function sendBeat(beat: Beat): void {
  window.dispatchEvent(new CustomEvent<Beat>(EVENT, { detail: beat }));
}

export function beatFromUrl(): Beat | null {
  const q = new URLSearchParams(window.location.search);
  const beat = q.get("beat");
  if (beat === "brief") return { beat };
  if (beat === "hotspot" && q.get("code")) return { beat, code: q.get("code")! };
  return null;
}

export function onBeat(handler: (beat: Beat) => void): () => void {
  const listen = (e: Event) => handler((e as CustomEvent<Beat>).detail);
  window.addEventListener(EVENT, listen);
  return () => window.removeEventListener(EVENT, listen);
}
