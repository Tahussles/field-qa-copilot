"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { GeoJSONSource, LngLatBoundsLike, Map as MlMap, MapLayerMouseEvent } from "maplibre-gl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Glass } from "@/components/ui/Glass";
import { STYLE_URL, tuneBasemap } from "@/lib/basemap";
import { CHECK_LABEL, CHECK_TITLE, COLORS, mainSignal, scoreColor } from "@/lib/checks";
import { fmtDuration, fmtStamp, shortId } from "@/lib/format";
import type { ContributorRow, Hotspot, MapData, MapPoint } from "@/lib/types";

const PASSED = "#9aa0aa"; // the prototype's passed-dot grey (drawn at 35% opacity)
const CARD = { w: 236, h: 132 };
const CHIP = { w: 252, h: 34 };
const NARROW = 560; // below this map width, chips use short text

type Rect = { x: number; y: number; w: number; h: number };
interface PlacedHotspot {
  key: string;
  hotspot: Hotspot;
  x: number;
  y: number;
  r: number;
  box: Rect | null; // null: no clear spot for the chip, only the ring shows
  compact: boolean;
}
interface Pulse {
  id: string;
  x: number;
  y: number;
  color: string;
}
interface Tip {
  x: number;
  y: number;
  width: number; // map size when the tooltip opened, to keep it inside
  height: number;
  point: MapPoint;
}

const hotspotKey = (h: Hotspot) => `${h.contributor_code}-${h.first_date}-${h.centroid.lat}`;
const compactWidth = (h: Hotspot) => Math.round(70 + `${h.count} in one spot`.length * 6.6);

/** "Oct 27" or "Oct 27 to 31" from local dates (YYYY-MM-DD). */
function dateSpan(first: string, last: string): string {
  const month = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = (d: string) => Number(d.slice(8, 10));
  if (first === last) return `${month(first)} ${day(first)}`;
  return month(first) === month(last)
    ? `${month(first)} ${day(first)} to ${day(last)}`
    : `${month(first)} ${day(first)} to ${month(last)} ${day(last)}`;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function overlaps(a: Rect, b: Rect, pad = 4): boolean {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}

function boundsOf(coords: [number, number][]): LngLatBoundsLike | null {
  if (!coords.length) return null;
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coords) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [
    [minX, minY],
    [maxX, maxY],
  ];
}

function pointFeatures(points: MapPoint[]) {
  return {
    type: "FeatureCollection" as const,
    features: points.map((p) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
      properties: {
        id: p.id,
        code: p.code,
        band: p.band,
        flagged: p.band === "flagged",
        score: p.score,
        live: p.source === "live",
        color: p.score >= 5 ? COLORS.crit : p.band === "flagged" ? COLORS.warn : PASSED,
      },
    })),
  };
}

function areaFeatures(data: MapData) {
  const polygons = data.areas.filter((a) => a.boundary);
  return {
    shapes: {
      type: "FeatureCollection" as const,
      features: polygons.map((a) => ({ type: "Feature" as const, geometry: a.boundary!, properties: { name: a.name } })),
    },
    labels: {
      type: "FeatureCollection" as const,
      features: polygons.map((a) => {
        const ring = a.boundary!.coordinates[0].slice(0, -1);
        const lng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
        const lat = Math.max(...ring.map((c) => c[1])) - 0.0016; // just inside the top edge
        return {
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [lng, lat] },
          properties: { name: a.name.toUpperCase() },
        };
      }),
    },
  };
}

export function MapPanel({
  data,
  contributors,
  focus,
  onFocus,
  pulses,
}: {
  data: MapData | null;
  contributors: Record<string, ContributorRow>;
  focus: string | null;
  onFocus: (code: string | null) => void;
  pulses: string[];
}) {
  const router = useRouter();
  const wrap = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  const seg = useRef<HTMLDivElement>(null);
  const reset = useRef<HTMLButtonElement>(null);
  const legend = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const dataRef = useRef<MapData | null>(null);
  const viewRef = useRef({ expanded: null as string | null, pulses: [] as string[] });
  const frame = useRef<number | null>(null);

  const [ready, setReady] = useState(false);
  const [moved, setMoved] = useState(false);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [placed, setPlaced] = useState<PlacedHotspot[]>([]);
  const [pulseSpots, setPulseSpots] = useState<Pulse[]>([]);
  const [tip, setTip] = useState<Tip | null>(null);
  const [rendered, setRendered] = useState(0);

  const pointsById = useMemo(() => new Map((data?.points ?? []).map((p) => [p.id, p])), [data]);

  const homeBounds = useCallback((): LngLatBoundsLike | null => {
    const areas = dataRef.current?.areas ?? [];
    return boundsOf(areas.flatMap((a) => (a.boundary?.coordinates[0] ?? []) as [number, number][]));
  }, []);

  // Place hotspot chips (or the open card) so they never overlap each other, the
  // info pill, the controls or the legend; prefer not to cover another ring.
  // Candidates follow the prototype: above, below, right, left of the ring.
  const layout = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const map = mapRef.current;
      const box = wrap.current;
      const current = dataRef.current;
      if (!map || !box || !current) return;
      const width = box.clientWidth;
      const height = box.clientHeight;
      const compact = width < NARROW;
      const relative = (el: HTMLElement | null): Rect | null => {
        if (!el || !el.offsetParent) return null;
        const a = el.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height };
      };
      const fixed = [pill, seg, reset, legend].map((r) => relative(r.current)).filter(Boolean) as Rect[];
      const zoom = map.getZoom();
      const spots = [...current.hotspots]
        .sort((a, b) => b.count - a.count)
        .map((h) => {
          const p = map.project([h.centroid.lng, h.centroid.lat]);
          const metresPerPixel = (40075016.686 * Math.cos((h.centroid.lat * Math.PI) / 180)) / (512 * 2 ** zoom);
          const r = Math.min(64, Math.max(9, h.radius_m / metresPerPixel + 3));
          return { h, x: p.x, y: p.y, r };
        })
        .filter((s) => s.x > -40 && s.y > -40 && s.x < width + 40 && s.y < height + 40);
      const rings = spots.map((s) => ({ x: s.x - s.r, y: s.y - s.r, w: 2 * s.r, h: 2 * s.r }));
      const chips: Rect[] = [];
      const out: PlacedHotspot[] = [];
      for (const [i, s] of spots.entries()) {
        const key = hotspotKey(s.h);
        const open = viewRef.current.expanded === key;
        const size = open ? CARD : compact ? { w: compactWidth(s.h), h: CHIP.h } : CHIP;
        const gap = 12;
        const candidates: Rect[] = [
          { x: s.x - size.w / 2, y: s.y - s.r - gap - size.h },
          { x: s.x - size.w / 2, y: s.y + s.r + gap },
          { x: s.x + s.r + gap, y: s.y - size.h / 2 },
          { x: s.x - s.r - gap - size.w, y: s.y - size.h / 2 },
          { x: s.x + s.r * 0.7 + gap, y: s.y - s.r - size.h },
          { x: s.x + s.r * 0.7 + gap, y: s.y + s.r },
          { x: s.x - s.r * 0.7 - gap - size.w, y: s.y - s.r - size.h },
          { x: s.x - s.r * 0.7 - gap - size.w, y: s.y + s.r },
        ].map((c) => ({ ...c, ...size }));
        const inside = (c: Rect) => c.x >= 8 && c.y >= 8 && c.x + c.w <= width - 8 && c.y + c.h <= height - 8;
        const clear = (c: Rect, avoidRings: boolean) =>
          inside(c) &&
          ![...fixed, ...chips].some((o) => overlaps(c, o)) &&
          !(avoidRings && rings.some((ring, j) => overlaps(c, ring, 0) && j !== i)) &&
          !overlaps(c, rings[i], -2);
        // An open card always shows (clamped inside the map); a chip with no clear
        // spot is skipped rather than drawn over another chip.
        const chosen =
          candidates.find((c) => clear(c, true)) ??
          candidates.find((c) => clear(c, false)) ??
          (open
            ? {
                ...candidates[0],
                x: Math.min(Math.max(candidates[0].x, 8), width - size.w - 8),
                y: Math.min(Math.max(candidates[0].y, 8), height - size.h - 8),
              }
            : null);
        if (chosen) chips.push(chosen);
        out.push({ key, hotspot: s.h, x: s.x, y: s.y, r: s.r, box: chosen, compact });
      }
      setPlaced(out);
      const byId = new Map(current.points.map((p) => [p.id, p]));
      setPulseSpots(
        viewRef.current.pulses.flatMap((id) => {
          const point = byId.get(id);
          if (!point) return [];
          const p = map.project([point.lng, point.lat]);
          return [{ id, x: p.x, y: p.y, color: scoreColor(point.score, point.band) }];
        }),
      );
    });
  }, []);

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    let map: MlMap | null = null;
    void import("maplibre-gl").then((maplibregl) => {
      if (cancelled || !container.current) return;
      // Copied into public/ by scripts/vendor-maplibre.mjs.
      maplibregl.setWorkerUrl(`/vendor/maplibre-gl-worker.mjs?v=${maplibregl.getVersion()}`);
      const instance = new maplibregl.Map({
        container: container.current,
        style: STYLE_URL,
        center: [34.7975, -0.08],
        zoom: 13,
        attributionControl: { compact: true },
        dragRotate: false,
        pitchWithRotate: false,
        fadeDuration: reducedMotion() ? 0 : 300,
      });
      map = instance;
      mapRef.current = instance;
      instance.touchZoomRotate.disableRotation();
      instance.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: "metric" }), "bottom-right");
      instance.on("load", () => {
        if (!map) return;
        tuneBasemap(map);
        const current = dataRef.current;
        const areas = current ? areaFeatures(current) : null;
        map.addSource("areas", { type: "geojson", data: areas?.shapes ?? { type: "FeatureCollection", features: [] } });
        map.addSource("area-labels", { type: "geojson", data: areas?.labels ?? { type: "FeatureCollection", features: [] } });
        map.addSource("points", { type: "geojson", data: pointFeatures(current?.points ?? []) });
        map.addLayer({
          id: "area-line",
          type: "line",
          source: "areas",
          paint: { "line-color": "rgba(255,255,255,0.16)", "line-width": 1, "line-dasharray": [4, 4] },
        });
        map.addLayer({
          id: "area-label",
          type: "symbol",
          source: "area-labels",
          layout: {
            "text-field": ["get", "name"],
            "text-font": ["Noto Sans Bold"],
            "text-size": 9.5,
            "text-letter-spacing": 0.13,
            "text-anchor": "top",
          },
          paint: { "text-color": "rgba(255,255,255,0.36)", "text-halo-color": "#0b0c0f", "text-halo-width": 1 },
        });
        map.addLayer({
          id: "points",
          type: "circle",
          source: "points",
          layout: { "circle-sort-key": ["get", "score"] },
          paint: {
            "circle-color": ["get", "color"],
            "circle-radius": [
              "interpolate", ["linear"], ["zoom"],
              11, ["case", ["get", "flagged"], 2.3, 1.6],
              14, ["case", ["get", "flagged"], 3.4, 2.4],
              17, ["case", ["get", "flagged"], 6.5, 5],
            ],
            "circle-opacity": ["case", ["get", "flagged"], 0.95, 0.35],
          },
        });
        // Submissions from a phone on /collect get an indigo ring, so a live demo stands out.
        map.addLayer({
          id: "live-ring",
          type: "circle",
          source: "points",
          filter: ["==", ["get", "live"], true],
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 5, 14, 7.5, 17, 12],
            "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-color": COLORS.accent,
            "circle-stroke-width": 2,
          },
        });
        const home = homeBounds();
        if (home) map.fitBounds(home, { padding: 28, duration: 0 });
        map.on("movestart", (e) => {
          if ((e as { originalEvent?: Event }).originalEvent) setMoved(true);
        });
        map.on("mousemove", "points", (e: MapLayerMouseEvent) => {
          const id = e.features?.[0]?.properties?.id as string | undefined;
          const point = id ? dataRef.current?.points.find((p) => p.id === id) : undefined;
          if (map) map.getCanvas().style.cursor = point ? "pointer" : "";
          const box = wrap.current;
          setTip(point ? { x: e.point.x, y: e.point.y, width: box?.clientWidth ?? 600, height: box?.clientHeight ?? 400, point } : null);
        });
        map.on("mouseleave", "points", () => {
          if (map) map.getCanvas().style.cursor = "";
          setTip(null);
        });
        map.on("click", "points", (e: MapLayerMouseEvent) => {
          const id = e.features?.[0]?.properties?.id as string | undefined;
          if (id) router.push(`/app/queue/${id}`);
        });
        map.on("move", layout);
        map.on("resize", layout);
        map.on("idle", () => {
          if (map?.getLayer("points")) setRendered(map.queryRenderedFeatures({ layers: ["points"] }).length);
        });
        setReady(true);
        layout();
      });
    });
    return () => {
      cancelled = true;
      if (frame.current) cancelAnimationFrame(frame.current);
      map?.remove();
      mapRef.current = null;
    };
  }, [homeBounds, layout, router]);

  // Keep sources in step with the latest data.
  useEffect(() => {
    dataRef.current = data;
    const map = mapRef.current;
    if (!map || !ready || !data) return;
    (map.getSource("points") as GeoJSONSource | undefined)?.setData(pointFeatures(data.points));
    const areas = areaFeatures(data);
    (map.getSource("areas") as GeoJSONSource | undefined)?.setData(areas.shapes);
    (map.getSource("area-labels") as GeoJSONSource | undefined)?.setData(areas.labels);
    layout();
  }, [data, ready, layout]);

  useEffect(() => {
    viewRef.current = { expanded, pulses };
    layout();
  }, [expanded, pulses, layout]);

  // Focus one contributor: fit to their points and dim everyone else. Flagged-only filter.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setPaintProperty(
      "points",
      "circle-opacity",
      focus
        ? ["case", ["==", ["get", "code"], focus], ["case", ["get", "flagged"], 0.95, 0.6], 0.07]
        : ["case", ["get", "flagged"], 0.95, 0.35],
    );
    map.setFilter("points", flaggedOnly ? ["==", ["get", "band"], "flagged"] : null);
    if (focus) {
      const coords = (dataRef.current?.points ?? []).filter((p) => p.code === focus).map((p) => [p.lng, p.lat] as [number, number]);
      const bounds = boundsOf(coords);
      if (bounds) map.fitBounds(bounds, { padding: 70, maxZoom: 16, duration: reducedMotion() ? 0 : 700 });
    }
  }, [focus, flaggedOnly, ready]);

  // The controls above can change size (Reset view appears); re-place the chips.
  useEffect(() => {
    layout();
  }, [moved, focus, layout]);

  function resetView() {
    const map = mapRef.current;
    const home = homeBounds();
    setExpanded(null);
    setMoved(false);
    onFocus(null);
    if (map && home) map.fitBounds(home, { padding: 28, duration: reducedMotion() ? 0 : 700 });
  }

  function openHotspot(item: PlacedHotspot) {
    const map = mapRef.current;
    setExpanded(item.key);
    setMoved(true);
    map?.flyTo({
      center: [item.hotspot.centroid.lng, item.hotspot.centroid.lat],
      zoom: Math.max(map.getZoom(), 15.6),
      duration: reducedMotion() ? 0 : 900,
    });
  }

  const showReset = moved || Boolean(focus) || Boolean(expanded);
  const caption = focus
    ? `${focus} ${contributors[focus]?.display_name ?? ""} · click the row again to clear`
    : data
      ? `${data.hotspots.length} hotspots · ${data.points.length} submissions`
      : "";

  return (
    <section aria-label="Map of submissions" className="panel overflow-hidden">
      <div className="ph">
        <h2>Where interviews are piling up</h2>
        <span className="ph-caption truncate">{caption}</span>
      </div>
      <div
        ref={wrap}
        className="relative aspect-[4/3] overflow-hidden rounded-b-[10px] bg-[#0b0c0f] lg:aspect-[3/2]"
        data-map-ready={ready}
        data-points={data?.points.length ?? 0}
        data-rendered-points={rendered}
      >
        {/* Full size, not absolute: MapLibre's own CSS sets position: relative on this element. */}
        <div ref={container} className="h-full w-full" />

        {/* Hotspot rings (dashed, pulsing), live pulses, chips and the open card. */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden={!placed.length}>
          {placed.map((item) => (
            <svg
              key={`ring-${item.key}`}
              className="absolute"
              style={{ left: item.x - item.r - 2, top: item.y - item.r - 2, width: item.r * 2 + 4, height: item.r * 2 + 4 }}
              aria-hidden
            >
              <circle
                className="hring"
                cx={item.r + 2}
                cy={item.r + 2}
                r={item.r}
                fill="rgba(235,90,87,0.08)"
                stroke={COLORS.crit}
                strokeWidth="1.5"
                strokeDasharray="3 3"
              />
            </svg>
          ))}
          {pulseSpots.map((p) => (
            <span key={`pulse-${p.id}`} className="point-pulse" style={{ left: p.x, top: p.y, color: p.color }} />
          ))}
          {placed.map((item) =>
            !item.box ? null : expanded === item.key ? (
              <Glass
                key={`card-${item.key}`}
                role="dialog"
                aria-label={`Hotspot for ${item.hotspot.contributor_code}`}
                className="pointer-events-auto absolute z-[4] rounded-xl px-3 py-2.5 text-[12px] text-[#d9dbe0]"
                style={{ left: item.box.x, top: item.box.y, width: CARD.w }}
              >
                <div className="flex items-center gap-2 text-[11.5px] text-muted">
                  <span className="st st-crit">
                    <span>Hotspot</span>
                  </span>
                  <span className="truncate">
                    {item.hotspot.contributor_code} {contributors[item.hotspot.contributor_code]?.display_name}
                  </span>
                  <button
                    type="button"
                    aria-label="Close"
                    onClick={() => setExpanded(null)}
                    className="-my-1 ml-auto px-1 text-faint hover:text-ink"
                  >
                    ×
                  </button>
                </div>
                <b className="mt-[3px] mb-px block text-[13px] font-semibold text-white">
                  {item.hotspot.count} interviews in one spot
                </b>
                <div className="text-muted">
                  {dateSpan(item.hotspot.first_date, item.hotspot.last_date)}
                  {item.hotspot.avg_duration_sec != null && ` · avg ${Math.round(item.hotspot.avg_duration_sec / 60)} min`}
                  {item.hotspot.mostly_off_hours && " · mostly after 22:00"}
                </div>
                <MainSignalLine checks={contributors[item.hotspot.contributor_code]?.checks_fired} />
                <button
                  type="button"
                  onClick={() => router.push(`/app/queue?contributor=${item.hotspot.contributor_code}`)}
                  className="glass glass-btn mt-2 flex w-full justify-center rounded-md px-2.5 py-1 text-[12px] text-ink"
                >
                  Review these {item.hotspot.count} →
                </button>
              </Glass>
            ) : (
              <Glass
                key={`chip-${item.key}`}
                as="button"
                type="button"
                onClick={() => openHotspot(item)}
                aria-label={`${item.hotspot.contributor_code} · ${item.hotspot.count} interviews in one spot`}
                className="glass-btn pointer-events-auto absolute z-[4] flex items-center gap-2 rounded-full px-3 text-[12px] whitespace-nowrap text-white"
                style={{ left: item.box.x, top: item.box.y, height: CHIP.h, width: item.box.w }}
              >
                <span className="st st-crit">
                  <span className="font-mono">{item.hotspot.contributor_code}</span>
                </span>
                {item.compact ? `${item.hotspot.count} in one spot` : `${item.hotspot.count} interviews in one spot`}
                {!item.compact && <span className="ml-auto text-faint">Zoom</span>}
              </Glass>
            ),
          )}
        </div>

        {/* What am I looking at. */}
        <Glass
          ref={pill}
          className="absolute top-3 left-3 z-[3] max-w-[calc(100%-24px)] rounded-[10px] px-[11px] py-[7px] text-[11.5px] leading-[1.45] text-[#cfd2d6] lg:max-w-[min(300px,55%)]"
        >
          <b className="font-medium text-white">Each dot is one submission</b> at the GPS spot it was recorded. Homes are spread
          out, so a tight orange pile means forms filled in at one place.
        </Glass>

        {/* Controls. */}
        <Glass
          ref={seg}
          className="absolute bottom-3 left-3 z-[3] flex gap-0.5 rounded-full p-[3px] lg:top-3 lg:right-3 lg:bottom-auto lg:left-auto"
          role="group"
          aria-label="Which submissions to show"
        >
          {[
            { label: "All", value: false },
            { label: "Flagged only", value: true },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={flaggedOnly === option.value}
              onClick={() => setFlaggedOnly(option.value)}
              className={`rounded-full px-[11px] py-1 text-[12px] ${
                flaggedOnly === option.value
                  ? "bg-white/[0.14] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.2)]"
                  : "text-muted hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          ))}
        </Glass>
        {showReset && (
          <Glass
            ref={reset}
            as="button"
            type="button"
            onClick={resetView}
            className="glass-btn absolute top-3 right-3 z-[3] rounded-full px-3 py-1 text-[12px] text-ink lg:top-[50px]"
          >
            Reset view
          </Glass>
        )}

        <Glass
          ref={legend}
          className="absolute bottom-3 left-3 z-[3] hidden items-center gap-3 rounded-full px-3 py-1.5 text-[11.5px] text-[#cfd2d6] lg:flex"
        >
          {[
            ["Passed", COLORS.pass],
            ["Flagged", COLORS.warn],
            ["Score 5+", COLORS.crit],
          ].map(([label, color]) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
              {label}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: COLORS.accent }} />
            Live phone
          </span>
          <span>Hover a dot for details</span>
        </Glass>

        {tip && (
          <Glass
            role="tooltip"
            className="pointer-events-none absolute z-[6] min-w-[170px] rounded-[10px] px-2.5 py-2 text-[12px] text-[#d9dbe0]"
            style={{
              left: tip.x + 14 > tip.width - 214 ? tip.x - 200 : tip.x + 14,
              top: tip.y + 14 > tip.height - 90 ? tip.y - 86 : tip.y + 14,
            }}
          >
            <b className="font-mono font-medium text-white">{shortId(tip.point.id)}</b> · {tip.point.code}{" "}
            {contributors[tip.point.code]?.display_name}
            <br />
            <span className="text-muted">
              {fmtStamp(tip.point.captured_at, data?.project.timezone)} · {fmtDuration(tip.point.duration_sec)}
            </span>
            <br />
            {tip.point.fired.length ? (
              <span className="text-warn">{tip.point.fired.map((k) => CHECK_TITLE[k]).join(" · ")}</span>
            ) : (
              <span className="text-ok">Passed all checks</span>
            )}
          </Glass>
        )}

        {!data && <p className="absolute inset-0 grid place-items-center text-sm text-muted">Loading the map…</p>}
        {data && pointsById.size === 0 && <p className="absolute inset-0 grid place-items-center text-sm text-muted">No submissions yet.</p>}
      </div>
    </section>
  );
}

function MainSignalLine({ checks }: { checks: ContributorRow["checks_fired"] | undefined }) {
  const signal = mainSignal(checks ?? {});
  if (!signal) return null;
  return (
    <div className="text-muted">
      Main signal <span className="text-ink-2">{CHECK_LABEL[signal]}</span>
    </div>
  );
}
