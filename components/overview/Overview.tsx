"use client";

import { useMemo, useState } from "react";

import { useAppData } from "@/components/app/AppData";
import { Brief } from "@/components/overview/Brief";
import { ContributorsTable } from "@/components/overview/ContributorsTable";
import { Kpis } from "@/components/overview/Kpis";
import { MapPanel } from "@/components/overview/MapPanel";

export function Overview() {
  const { overview, map, pulses, error } = useAppData();
  const [focus, setFocus] = useState<string | null>(null);
  const names = useMemo(
    () => Object.fromEntries((overview?.contributors ?? []).map((c) => [c.code, c.display_name ?? ""])),
    [overview],
  );

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-3">
      {error && (
        <p role="alert" className="panel border-crit/40 px-4 py-3 text-sm text-crit">
          Couldn&apos;t load data: {error}
        </p>
      )}
      <Kpis overview={overview} />
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <MapPanel data={map} names={names} focus={focus} onFocus={setFocus} pulses={pulses} />
        <Brief overview={overview} />
      </div>
      <ContributorsTable rows={overview?.contributors ?? []} focus={focus} onFocus={setFocus} />
    </div>
  );
}
