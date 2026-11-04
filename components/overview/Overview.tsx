"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

import { useAppData } from "@/components/app/AppData";
import { Kpis } from "@/components/app/Kpis";
import { ContributorsTable } from "@/components/overview/ContributorsTable";
import { NeedsAttention } from "@/components/overview/NeedsAttention";
import { beatFromUrl, onBeat, type Beat } from "@/lib/beats";
import { useTheme } from "@/lib/theme";

// The map (MapLibre, ~1 MB) loads after first paint; a same-size skeleton holds its place.
const MapPanel = dynamic(() => import("@/components/overview/MapPanel").then((m) => m.MapPanel), {
  ssr: false,
  loading: () => <MapSkeleton />,
});

function MapSkeleton() {
  return (
    <section aria-label="Map of submissions" aria-busy className="panel overflow-hidden">
      <div className="ph">
        <h2>Hotspots</h2>
      </div>
      <div className="relative aspect-[4/3] bg-map lg:aspect-[3/2]">
        <div className="map-skeleton absolute inset-0" aria-hidden />
        <p className="absolute inset-0 grid place-items-center text-sm text-muted">Loading the map…</p>
      </div>
    </section>
  );
}

export function Overview() {
  const { overview, map, pulses, error } = useAppData();
  const theme = useTheme();
  const [focus, setFocus] = useState<string | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);

  // The demo script's jumps: open the brief, or focus a contributor and open their biggest hotspot.
  useEffect(() => {
    const go = (beat: Beat) => {
      if (beat.beat === "brief") {
        const brief = document.getElementById("brief");
        brief?.scrollIntoView({ behavior: "smooth", block: "start" });
        brief?.classList.add("beat-ring");
        window.setTimeout(() => brief?.classList.remove("beat-ring"), 1600);
      } else {
        setFocus(beat.code);
        setOpenFor(beat.code);
      }
    };
    const fromUrl = beatFromUrl();
    if (fromUrl) queueMicrotask(() => go(fromUrl));
    return onBeat(go);
  }, []);
  const contributors = useMemo(
    () => Object.fromEntries((overview?.contributors ?? []).map((c) => [c.code, c])),
    [overview],
  );

  return (
    <div className="flex flex-col gap-5">
      <Kpis />
      {error && (
        <p role="alert" className="panel border-crit/40 px-4 py-3 text-sm text-crit">
          Couldn&apos;t load data: {error}
        </p>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        {/* A new map per theme: its basemap style and point colours come from the theme. */}
        <MapPanel key={theme} data={map} contributors={contributors} focus={focus} onFocus={setFocus} pulses={pulses}
          openFor={openFor} onOpened={() => setOpenFor(null)} />
        <NeedsAttention overview={overview} focus={focus} onFocus={setFocus} />
      </div>
      <ContributorsTable rows={overview?.contributors ?? []} focus={focus} onFocus={setFocus} />
    </div>
  );
}
