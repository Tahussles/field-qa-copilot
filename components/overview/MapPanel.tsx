"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { GeoJSONSource, LngLatBoundsLike, Map as MlMap, MapLayerMouseEvent } from "maplibre-gl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Glass } from "@/components/ui/Glass";
import { CHECK_LABEL, COLORS, mainSignal, scoreColor } from "@/lib/checks";
import { fmtDateTime, fmtDuration, fmtLocalDate, shortId } from "@/lib/format";
import type { ContributorRow, Hotspot, MapData, MapPoint } from "@/lib/types";

// OpenFreeMap: free vector tiles, no API key. Attribution comes from the tile source.
const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
const CARD = { w: 264, h: 168 };
const CHIP_H = 28;

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
  width: number; // container width when the tooltip opened, to keep it inside
  point: MapPoint;
}

const hotspotKey = (h: Hotspot) => `${h.contributor_code}-${h.first_date}-${h.centroid.lat}`;
const NARROW = 560; // below this map width, chips drop "interviews"
const chipNote = (h: Hotspot, compact: boolean) => `· ${h.count} ${compact ? "in one spot" : "interviews in one spot"}`;
const chipWidth = (h: Hotspot, compact: boolean) => Math.round(36 + (h.contributor_code.length + chipNote(h, compact).length) * 6.7);

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
      properties: { id: p.id, code: p.code, band: p.band, score: p.score, color: scoreColor(p.score, p.band) },
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

/** Recolour OpenFreeMap's dark style to our palette. */
function tuneBasemap(map: MlMap) {
  const paint = (id: string, prop: string, value: unknown) => {
    try {
      (map.setPaintProperty as (layer: string, name: string, v: unknown) => void).call(map, id, prop, value);
    } catch {
      // layer without that property
    }
  };
  for (const layer of map.getStyle().layers ?? []) {
    const id = layer.id;
    if (layer.type === "background") paint(id, "background-color", "#08090a");
    else if (id === "water") paint(id, "fill-color", "#0a0f15");
    else if (id === "waterway") paint(id, "line-color", "#0a0f15");
    else if (id === "building") {
      paint(id, "fill-color", "#0d0e11");
      paint(id, "fill-outline-color", "#16181c");
    } else if (layer.type === "fill") paint(id, "fill-color", "#0b0c0e");
    else if (layer.type === "line" && id.startsWith("highway")) {
      paint(id, "line-color", id.includes("major") || id.includes("motorway") ? "#23262d" : "#191b20");
    } else if (layer.type === "line") paint(id, "line-color", "#16181c");
    else if (/^place_(other|suburb|village)$/.test(id)) {
      // Real neighbourhood names would sit next to our survey area labels.
      map.setLayoutProperty(id, "visibility", "none");
    } else if (layer.type === "symbol") {
      paint(id, "text-color", "#4b5059");
      paint(id, "text-halo-color", "#08090a");
    }
  }
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
  const container = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const dataRef = useRef<MapData | null>(null);
  const viewRef = useRef({ expanded: null as string | null, pulses: [] as string[] });
  const frame = useRef<number | null>(null);

  const [ready, setReady] = useState(false);
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

  // Place hotspot chips (or the expanded card) so they never overlap each other,
  // the info pill or the controls; prefer not to cover another hotspot ring.
  const layout = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const map = mapRef.current;
      const box = container.current;
      const current = dataRef.current;
      if (!map || !box || !current) return;
      const width = box.clientWidth;
      const height = box.clientHeight;
      const relative = (el: HTMLElement | null): Rect | null => {
        if (!el) return null;
        const a = el.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height };
      };
      const fixed = [relative(pill.current), relative(controls.current)].filter(Boolean) as Rect[];
      const zoom = map.getZoom();
      const spots = [...current.hotspots]
        .sort((a, b) => b.count - a.count)
        .map((h) => {
          const p = map.project([h.centroid.lng, h.centroid.lat]);
          const metresPerPixel = (40075016.686 * Math.cos((h.centroid.lat * Math.PI) / 180)) / (512 * 2 ** zoom);
          const r = Math.min(64, Math.max(13, h.radius_m / metresPerPixel + 7));
          return { h, x: p.x, y: p.y, r };
        })
        .filter((s) => s.x > -40 && s.y > -40 && s.x < width + 40 && s.y < height + 40);
      const rings = spots.map((s) => ({ x: s.x - s.r, y: s.y - s.r, w: 2 * s.r, h: 2 * s.r }));
      const chips: Rect[] = [];
      const out: PlacedHotspot[] = [];
      for (const [i, s] of spots.entries()) {
        const key = hotspotKey(s.h);
        const size = viewRef.current.expanded === key ? CARD : { w: chipWidth(s.h, width < NARROW), h: CHIP_H };
        const gap = 9;
        const candidates: Rect[] = [
          { x: s.x + s.r + gap, y: s.y - size.h / 2 },
          { x: s.x - s.r - gap - size.w, y: s.y - size.h / 2 },
          { x: s.x - size.w / 2, y: s.y - s.r - gap - size.h },
          { x: s.x - size.w / 2, y: s.y + s.r + gap },
          { x: s.x + s.r * 0.7 + gap, y: s.y - s.r - size.h },
          { x: s.x + s.r * 0.7 + gap, y: s.y + s.r },
          { x: s.x - s.r * 0.7 - gap - size.w, y: s.y - s.r - size.h },
          { x: s.x - s.r * 0.7 - gap - size.w, y: s.y + s.r },
        ].map((c) => ({ ...c, ...size }));
        const inside = (c: Rect) => c.x >= 6 && c.y >= 6 && c.x + c.w <= width - 6 && c.y + c.h <= height - 6;
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
          (viewRef.current.expanded === key
            ? {
                ...candidates[0],
                x: Math.min(Math.max(candidates[0].x, 6), width - size.w - 6),
                y: Math.min(Math.max(candidates[0].y, 6), height - size.h - 6),
              }
            : null);
        if (chosen) chips.push(chosen);
        out.push({ key, hotspot: s.h, x: s.x, y: s.y, r: s.r, box: chosen, compact: width < NARROW });
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
      instance.on("load", () => {
        if (!map) return;
        tuneBasemap(map);
        const current = dataRef.current;
        const areas = current ? areaFeatures(current) : null;
        map.addSource("areas", { type: "geojson", data: areas?.shapes ?? { type: "FeatureCollection", features: [] } });
        map.addSource("area-labels", { type: "geojson", data: areas?.labels ?? { type: "FeatureCollection", features: [] } });
        map.addSource("points", {
          type: "geojson",
          data: pointFeatures(current?.points ?? []),
        });
        map.addLayer({ id: "area-fill", type: "fill", source: "areas", paint: { "fill-color": "#ffffff", "fill-opacity": 0.012 } });
        map.addLayer({
          id: "area-line",
          type: "line",
          source: "areas",
          paint: { "line-color": "rgba(255,255,255,0.24)", "line-width": 1, "line-dasharray": [3, 3] },
        });
        map.addLayer({
          id: "area-label",
          type: "symbol",
          source: "area-labels",
          layout: {
            "text-field": ["get", "name"],
            "text-font": ["Noto Sans Regular"],
            "text-size": 10,
            "text-letter-spacing": 0.18,
            "text-anchor": "top",
          },
          paint: { "text-color": "#6b707a", "text-halo-color": "#08090a", "text-halo-width": 1.2 },
        });
        map.addLayer({
          id: "points",
          type: "circle",
          source: "points",
          layout: { "circle-sort-key": ["get", "score"] },
          paint: {
            "circle-color": ["get", "color"],
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.2, 14, 4, 17, 7],
            "circle-stroke-color": "#08090a",
            "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11, 0.3, 15, 1],
            "circle-opacity": 0.92,
          },
        });
        const home = homeBounds();
        if (home) map.fitBounds(home, { padding: 28, duration: 0 });
        map.on("mousemove", "points", (e: MapLayerMouseEvent) => {
          const id = e.features?.[0]?.properties?.id as string | undefined;
          const point = id ? dataRef.current?.points.find((p) => p.id === id) : undefined;
          if (map) map.getCanvas().style.cursor = point ? "pointer" : "";
          setTip(point ? { x: e.point.x, y: e.point.y, width: container.current?.clientWidth ?? 600, point } : null);
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
    map.setPaintProperty("points", "circle-opacity", focus ? ["case", ["==", ["get", "code"], focus], 0.95, 0.1] : 0.92);
    map.setFilter("points", flaggedOnly ? ["==", ["get", "band"], "flagged"] : null);
    const duration = reducedMotion() ? 0 : 700;
    if (focus) {
      const coords = (dataRef.current?.points ?? []).filter((p) => p.code === focus).map((p) => [p.lng, p.lat] as [number, number]);
      const bounds = boundsOf(coords);
      if (bounds) map.fitBounds(bounds, { padding: 70, maxZoom: 16, duration });
    }
  }, [focus, flaggedOnly, ready]);

  function resetView() {
    const map = mapRef.current;
    const home = homeBounds();
    setExpanded(null);
    onFocus(null);
    if (map && home) map.fitBounds(home, { padding: 28, duration: reducedMotion() ? 0 : 700 });
  }

  function openHotspot(item: PlacedHotspot) {
    const map = mapRef.current;
    setExpanded(item.key);
    map?.flyTo({
      center: [item.hotspot.centroid.lng, item.hotspot.centroid.lat],
      zoom: Math.max(map.getZoom(), 15.6),
      duration: reducedMotion() ? 0 : 900,
    });
  }

  const flaggedCount = data?.points.filter((p) => p.band === "flagged").length ?? 0;

  return (
    <section aria-label="Map of submissions" className="panel relative h-[420px] overflow-hidden p-0 md:h-[560px] xl:h-[600px]">
      <div
        ref={container}
        className="relative h-full w-full"
        data-map-ready={ready}
        data-points={data?.points.length ?? 0}
        data-rendered-points={rendered}
      />

      {/* Hotspot rings, chips and the expanded card. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden={!placed.length}>
        {placed.map((item) => (
          <div
            key={`ring-${item.key}`}
            className="hotspot-ring"
            style={{ left: item.x, top: item.y, width: item.r * 2, height: item.r * 2 }}
          />
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
              className="pointer-events-auto absolute rounded-xl p-3 text-[12.5px]"
              style={{ left: item.box.x, top: item.box.y, width: CARD.w }}
            >
              <div className="flex items-start gap-2">
                <span className="dot mt-1 bg-crit" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">
                    <span className="font-mono">{item.hotspot.contributor_code}</span>{" "}
                    {contributors[item.hotspot.contributor_code]?.display_name ?? ""}
                  </p>
                  <p className="text-muted">{item.hotspot.count} interviews within {Math.round(item.hotspot.radius_m)} m</p>
                </div>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setExpanded(null)}
                  className="-mt-1 -mr-1 rounded-md px-1.5 text-muted hover:text-ink"
                >
                  ×
                </button>
              </div>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                <dt className="text-faint">Dates</dt>
                <dd className="text-ink-2">
                  {fmtLocalDate(item.hotspot.first_date)}
                  {item.hotspot.last_date !== item.hotspot.first_date && ` – ${fmtLocalDate(item.hotspot.last_date)}`} ·{" "}
                  {item.hotspot.days} {item.hotspot.days === 1 ? "day" : "days"}
                </dd>
                <MainSignalRow checks={contributors[item.hotspot.contributor_code]?.checks_fired} />
                <dt className="text-faint">Avg duration</dt>
                <dd className="text-ink-2">{fmtDuration(item.hotspot.avg_duration_sec)}</dd>
                {item.hotspot.mostly_off_hours && (
                  <>
                    <dt className="text-faint">Time</dt>
                    <dd className="text-warn">Mostly after 22:00</dd>
                  </>
                )}
              </dl>
              <button
                type="button"
                onClick={() => router.push(`/app/queue?contributor=${item.hotspot.contributor_code}`)}
                className="mt-2.5 text-[12.5px] font-medium text-accent hover:brightness-125"
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
              className="pointer-events-auto absolute flex items-center gap-1.5 rounded-full px-2.5 text-[12px] whitespace-nowrap text-ink hover:brightness-125"
              style={{ left: item.box.x, top: item.box.y, height: CHIP_H }}
            >
              <span className="dot bg-crit" aria-hidden />
              <span className="font-mono">{item.hotspot.contributor_code}</span>
              <span className="text-muted">{chipNote(item.hotspot, item.compact)}</span>
            </Glass>
          ),
        )}
      </div>

      {/* Controls. */}
      <div ref={controls} className="absolute top-3 right-3 flex items-center gap-2">
        <Glass className="flex rounded-lg p-0.5 text-[12px]" role="group" aria-label="Which points to show">
          {[
            { label: "All", value: false },
            { label: `Flagged only · ${flaggedCount}`, value: true },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={flaggedOnly === option.value}
              onClick={() => setFlaggedOnly(option.value)}
              className={`rounded-md px-2.5 py-1 ${flaggedOnly === option.value ? "bg-white/[0.1] text-ink" : "text-muted hover:text-ink"}`}
            >
              {option.label}
            </button>
          ))}
        </Glass>
        <Glass as="button" type="button" onClick={resetView} className="rounded-lg px-2.5 py-1.5 text-[12px] text-muted hover:text-ink">
          Reset view
        </Glass>
      </div>

      {/* What am I looking at. */}
      <Glass
        ref={pill}
        className="absolute bottom-3 left-3 flex items-center gap-3 rounded-full px-3 py-1.5 text-[11.5px] whitespace-nowrap text-muted"
      >
        <span className="flex items-center gap-1.5">
          <span className="dot" style={{ background: COLORS.pass }} /> passed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="dot bg-warn" /> flagged
        </span>
        <span className="flex items-center gap-1.5">
          <span className="dot bg-crit" /> score ≥ 5
        </span>
        <span className="hidden text-faint sm:inline">· one dot per submission</span>
      </Glass>

      {tip && (
        <Glass
          role="tooltip"
          className="pointer-events-none absolute z-10 w-60 rounded-lg px-3 py-2 text-[12px]"
          style={{
            left: Math.min(tip.x + 14, tip.width - 250),
            top: Math.max(tip.y - 16, 8),
          }}
        >
          <p className="flex items-center gap-1.5 text-ink">
            <span className="font-mono">{shortId(tip.point.id)}</span>
            <span className="text-faint">·</span>
            <span className="font-mono">{tip.point.code}</span>
            <span className="truncate text-muted">{contributors[tip.point.code]?.display_name}</span>
          </p>
          <p className="mt-0.5 text-muted">
            {fmtDateTime(tip.point.captured_at, data?.project.timezone)} · {fmtDuration(tip.point.duration_sec)}
          </p>
          <p className="mt-1" style={{ color: scoreColor(tip.point.score, tip.point.band) }}>
            {tip.point.fired.length ? tip.point.fired.map((k) => CHECK_LABEL[k]).join(" + ") : "No checks fired"}
            <span className="text-faint"> · score {tip.point.score}</span>
          </p>
        </Glass>
      )}

      {!data && <p className="absolute inset-0 grid place-items-center text-sm text-muted">Loading the map…</p>}
      {data && pointsById.size === 0 && <p className="absolute inset-0 grid place-items-center text-sm text-muted">No submissions yet.</p>}
    </section>
  );
}

function MainSignalRow({ checks }: { checks: ContributorRow["checks_fired"] | undefined }) {
  const signal = mainSignal(checks ?? {});
  if (!signal) return null;
  return (
    <>
      <dt className="text-faint">Main signal</dt>
      <dd className="text-ink-2">{CHECK_LABEL[signal]}</dd>
    </>
  );
}
