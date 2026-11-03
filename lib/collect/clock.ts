// The phone's own clock. A demo control can set it back 3 hours, as a fabricator might to make night
// forms look like evening work: every time the phone reports (capture and sync) then runs 3 h behind,
// and the clock_skew check sees the gap against the server's clock.

const KEY = "fqc-phone-clock-offset-min";
export const CLOCK_OFF_MINUTES = -180;

export function clockOffsetMinutes(): number {
  try {
    return Number(window.localStorage.getItem(KEY)) || 0;
  } catch {
    return 0;
  }
}

export function setClockOffsetMinutes(minutes: number): void {
  try {
    if (minutes) window.localStorage.setItem(KEY, String(minutes));
    else window.localStorage.removeItem(KEY);
  } catch {
    // private mode: the toggle lasts for this page only
  }
}

/** What the phone's clock reads now. */
export function phoneNow(): Date {
  return new Date(Date.now() + clockOffsetMinutes() * 60_000);
}
