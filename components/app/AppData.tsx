"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useToast } from "@/components/app/Toasts";
import { api } from "@/lib/api";
import { CHECK_LABEL } from "@/lib/checks";
import { shortId } from "@/lib/format";
import { browserSupabase } from "@/lib/supabase";
import type { MapData, Overview } from "@/lib/types";

const REFRESH_DEBOUNCE_MS = 1000;
const PULSE_MS = 3400;

interface AppData {
  overview: Overview | null;
  map: MapData | null;
  error: string | null;
  /** Bumps whenever fresh data arrives; views that fetch their own data refetch on change. */
  version: number;
  live: "connecting" | "live" | "offline";
  /** Submission ids that just turned flagged, for a brief pulse on the map. */
  pulses: string[];
  refresh: () => void;
}

const AppDataContext = createContext<AppData>({
  overview: null,
  map: null,
  error: null,
  version: 0,
  live: "connecting",
  pulses: [],
  refresh: () => {},
});

export function AppDataProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [map, setMap] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [live, setLive] = useState<AppData["live"]>("connecting");
  const [pulses, setPulses] = useState<string[]>([]);
  const timer = useRef<number | null>(null);
  const flagged = useRef(new Map<string, boolean>());

  const load = useCallback(async () => {
    try {
      const [o, m] = await Promise.all([api.overview(), api.map()]);
      for (const p of m.points) flagged.current.set(p.id, p.band === "flagged");
      setOverview(o);
      setMap(m);
      setError(null);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load data");
    }
  }, []);

  const refresh = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void load();
    }, REFRESH_DEBOUNCE_MS);
  }, [load]);

  const announce = useCallback(
    async (id: string) => {
      setPulses((current) => [...current.filter((p) => p !== id), id]);
      window.setTimeout(() => setPulses((current) => current.filter((p) => p !== id)), PULSE_MS);
      try {
        const detail = await api.submission(id);
        const fired = detail.checks.filter((c) => c.fired).map((c) => CHECK_LABEL[c.key]);
        toast({
          tone: "flag",
          title: `${shortId(id)} flagged · ${detail.contributor.code} · ${fired.join(" + ") || "score"}`,
          body: detail.contributor.display_name ? `${detail.contributor.display_name}, ${detail.contributor.area}` : undefined,
        });
      } catch {
        toast({ tone: "flag", title: `${shortId(id)} flagged` });
      }
    },
    [toast],
  );

  useEffect(() => {
    // Initial load runs in a microtask so no state is set synchronously in the effect.
    queueMicrotask(() => void load());
    const supabase = browserSupabase();
    if (!supabase) {
      queueMicrotask(() => setLive("offline"));
      return;
    }
    const channel = supabase
      .channel("dashboard")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "submissions" }, () => refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "scores" }, (payload) => {
        // A demo reset deletes rows (cascading to scores): DELETE carries no new row, just refresh.
        if (payload.eventType === "DELETE") return refresh();
        const row = payload.new as { submission_id?: string; flagged?: boolean };
        if (!row?.submission_id) return;
        const was = flagged.current.get(row.submission_id) ?? false;
        flagged.current.set(row.submission_id, Boolean(row.flagged));
        if (row.flagged && !was) void announce(row.submission_id);
        refresh();
      })
      // Model work landing: a verdict (the score may change too), a job finishing, a brief written.
      .on("postgres_changes", { event: "*", schema: "public", table: "ai_verdicts" }, () => refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "ai_jobs" }, () => refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "briefs" }, () => refresh())
      .subscribe((status) => setLive(status === "SUBSCRIBED" ? "live" : status === "CLOSED" ? "offline" : "connecting"));
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      void supabase.removeChannel(channel);
    };
  }, [load, refresh, announce]);

  const value = useMemo(
    () => ({ overview, map, error, version, live, pulses, refresh }),
    [overview, map, error, version, live, pulses, refresh],
  );
  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData() {
  return useContext(AppDataContext);
}
