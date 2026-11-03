// Simulated locations for the demo phone (it is not in Kisumu), and the real GPS when asked.

type Ring = number[][]; // [lng, lat] pairs, closed

export interface Fix {
  lat: number;
  lng: number;
  accuracy_m: number;
  mode: "new" | "same" | "real";
}

function contains(ring: Ring, lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const M_PER_DEG = 111_320;

/** A random household inside the area, kept 40 m from its edge so GPS jitter cannot push it out. */
export function newHousehold(ring: Ring): Fix {
  const lngs = ring.map((c) => c[0]);
  const lats = ring.map((c) => c[1]);
  const margin = 40 / M_PER_DEG;
  for (let i = 0; i < 500; i++) {
    const lng = Math.min(...lngs) + Math.random() * (Math.max(...lngs) - Math.min(...lngs));
    const lat = Math.min(...lats) + Math.random() * (Math.max(...lats) - Math.min(...lats));
    const clear = [[0, margin], [0, -margin], [margin, 0], [-margin, 0]].every(([dx, dy]) => contains(ring, lng + dx, lat + dy));
    if (contains(ring, lng, lat) && clear) return { lat: round6(lat), lng: round6(lng), accuracy_m: 8, mode: "new" };
  }
  throw new Error("could not place a household in this area");
}

/** Within a few metres of the contributor's last interview. */
export function sameSpot(last: { lat: number; lng: number }): Fix {
  const jitter = () => (Math.random() - 0.5) * (6 / M_PER_DEG);
  return { lat: round6(last.lat + jitter()), lng: round6(last.lng + jitter()), accuracy_m: 6, mode: "same" };
}

export function realGps(): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("this browser has no GPS"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: round6(p.coords.latitude), lng: round6(p.coords.longitude), accuracy_m: Math.round(p.coords.accuracy), mode: "real" }),
      (e) => reject(new Error(e.code === e.PERMISSION_DENIED ? "location permission was denied" : "could not get a GPS fix")),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
}
