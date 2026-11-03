"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import { Glass } from "@/components/ui/Glass";
import basemap from "@/public/landing/basemap.json";
import basemapImage from "@/public/landing/basemap.webp";
import basemapLightImage from "@/public/landing/basemap-light.webp";
import { CHECK_TITLE } from "@/lib/checks";
import { fmtMonthDay, shortId } from "@/lib/format";
import { cssColor, useTheme } from "@/lib/theme";
import type { CheckKey, LandingData, SubmissionDetail } from "@/lib/types";

const ADD_MS = 90; // one replayed arrival per tick
const FEED_MS = 1100;
const FEED_ROWS = 9;
const SEED_SHARE = 0.5; // replay starts with half the day already on the map, as full as the prototype's stage
const LIVE_IDLE_MS = 30_000; // no real arrival for this long: back to the replay
const DETAIL_CONCURRENCY = 4;

interface Dot {
  id: string;
  code: string;
  lng: number;
  lat: number;
  score: number;
  flagged: boolean;
  fired: CheckKey[];
  born: number;
}
interface Row extends Dot {
  key: number;
  fresh: boolean;
}

// Web Mercator, to place a point on the pre-rendered image (scripts/render-basemap.mjs).
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const { west, east, north, south } = basemap.bounds;
const toImage = (lng: number, lat: number): [number, number] => [
  ((lng - west) / (east - west)) * basemap.width,
  ((mercY(north) - mercY(lat)) / (mercY(north) - mercY(south))) * basemap.height,
];
const AREAS = basemap.areas.map((a) => {
  const ring = a.ring.slice(0, -1);
  const lng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
  const lat = Math.max(...ring.map((c) => c[1])) - 0.0016; // just inside the top edge, as on the dashboard map
  return { name: a.name.toUpperCase(), ring: a.ring.map(([x, y]) => toImage(x, y)), label: toImage(lng, lat) };
});

/** The tile source's credit line as links (the HTML comes from our own basemap.json). */
const CREDITS = [...basemap.attribution.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => ({
  href: m[1],
  text: m[2].replace("&copy;", "©"),
}));

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** "r,g,b" of a #rrggbb token, for the canvas's rgba() strings. */
function triplet(token: string): string {
  const hex = cssColor(token).replace("#", "");
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0).join(",");
}

export function Stage() {
  const theme = useTheme();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<LandingData | null>(null);
  const [mode, setMode] = useState<"replay" | "live">("replay");
  const modeRef = useRef<"replay" | "live">("replay");
  const [rows, setRows] = useState<Row[]>([]);
  const dots = useRef<Dot[]>([]);
  const draw = useRef<(now: number) => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/py/landing")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((d: LandingData) => !cancelled && setData(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Canvas: area outlines, labels and dots over the image, with the prototype's arrival animation.
  useEffect(() => {
    const el = canvas.current;
    const box = wrap.current;
    if (!el || !box) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const font = getComputedStyle(document.body).fontFamily;
    // The theme's colours (a new theme runs this effect again).
    const areaLine = cssColor("--stage-area-line");
    const label = cssColor("--stage-label");
    const crit = triplet("--color-crit");
    const warn = triplet("--color-warn");
    const passed = triplet("--map-passed");
    const passedOpacity = Number(cssColor("--map-passed-opacity")) || 0.35;

    draw.current = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const w = box.clientWidth;
      const h = box.clientHeight;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // Same placement as the image's object-fit: cover.
      const sc = Math.max(w / basemap.width, h / basemap.height);
      const ox = (w - basemap.width * sc) / 2;
      const oy = (h - basemap.height * sc) / 2;
      const px = ([x, y]: [number, number]): [number, number] => [ox + x * sc, oy + y * sc];

      ctx.strokeStyle = areaLine;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (const area of AREAS) {
        ctx.beginPath();
        area.ring.forEach((p, i) => (i ? ctx.lineTo(...px(p)) : ctx.moveTo(...px(p))));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = label;
      ctx.font = `600 9.5px ${font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      if ("letterSpacing" in ctx) ctx.letterSpacing = "1.2px";
      for (const area of AREAS) ctx.fillText(area.name, ...px(area.label));

      for (const d of dots.current) {
        const age = (now - d.born) / 1000;
        const [x, y] = px(toImage(d.lng, d.lat));
        const col = d.score >= 5 ? crit : d.flagged ? warn : passed;
        const alpha = Math.min(1, age * 3) * (d.flagged ? 0.95 : passedOpacity);
        if (d.flagged && age < 1.6) {
          ctx.beginPath();
          ctx.arc(x, y, 3 + age * 14, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${col},${0.6 * (1 - age / 1.6)})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
        if (d.flagged) {
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${col},0.10)`;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(x, y, d.flagged ? 2.6 : 1.8, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${col},${alpha})`;
        ctx.fill();
      }
    };
    const observer = new ResizeObserver(() => draw.current(performance.now()));
    observer.observe(box);
    return () => observer.disconnect();
  }, [theme]);

  // Replay yesterday's real submissions, unless real arrivals are coming in (then: Live).
  useEffect(() => {
    if (!data || mode !== "replay") return;
    const order: Dot[] = data.points.map((p) => ({ ...p, flagged: p.band === "flagged", born: 0 }));
    if (!order.length) return;
    let key = 0;
    const row = (d: Dot, fresh: boolean): Row => ({ ...d, key: key++, fresh });
    // The latest few flagged and passed arrivals so far, newest first.
    const seedFeed = (seen: Dot[], flaggedRows: number, otherRows: number) => {
      const picked = new Set([...seen.filter((d) => d.flagged).slice(-flaggedRows), ...seen.filter((d) => !d.flagged).slice(-otherRows)]);
      return seen.filter((d) => picked.has(d)).reverse().map((d) => row(d, false));
    };

    if (reducedMotion()) {
      // A static frame: the whole day on the map, a fixed feed, no loop.
      dots.current = order.map((d) => ({ ...d, born: -1e6 }));
      queueMicrotask(() => setRows(seedFeed(order, 5, 4)));
      draw.current(performance.now());
      return;
    }

    const t0 = performance.now();
    let cursor = Math.floor(order.length * SEED_SHARE);
    dots.current = order.slice(0, cursor).map((d) => ({ ...d, born: t0 - 5000 }));
    queueMicrotask(() => setRows(seedFeed(order.slice(0, cursor), 4, 4)));
    let lastAdd = t0;
    let lastFeed = t0;
    let sinceFeed: Dot[] = [];
    let frame = 0;
    const tick = (now: number) => {
      if (now - lastAdd > ADD_MS) {
        lastAdd = now;
        if (cursor >= order.length) {
          cursor = 0;
          dots.current = [];
        }
        const d = { ...order[cursor++], born: now };
        dots.current.push(d);
        sinceFeed.push(d);
      }
      if (now - lastFeed > FEED_MS && sinceFeed.length) {
        lastFeed = now;
        // The newest arrival since the last row, preferring one that was flagged.
        const pick = [...sinceFeed].reverse().find((d) => d.flagged) ?? sinceFeed[sinceFeed.length - 1];
        sinceFeed = [];
        setRows((current) => [row(pick, true), ...current].slice(0, FEED_ROWS));
      }
      draw.current(now);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [data, mode]);

  // Live: real Realtime inserts (the demo runner or the simulator syncing). Loaded after first paint.
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    let idle: number | undefined;
    let key = 1e6;
    let frame = 0;
    const queue: string[] = [];
    let active = 0;

    const animate = (now: number) => {
      draw.current(now);
      frame = dots.current.some((d) => d.flagged && now - d.born < 1600) ? requestAnimationFrame(animate) : 0;
    };
    const arrive = async (id: string) => {
      const detail: SubmissionDetail = await fetch(`/api/py/submissions/${id}`).then((r) => r.json());
      const s = detail.submission;
      if (cancelled || s.lat == null || s.lng == null || !detail.score) return;
      const now = performance.now();
      const d: Dot = {
        id,
        code: detail.contributor.code,
        lng: s.lng,
        lat: s.lat,
        score: detail.score.score,
        flagged: detail.score.band === "flagged",
        fired: detail.checks.filter((c) => c.fired).map((c) => c.key),
        born: reducedMotion() ? -1e6 : now,
      };
      dots.current.push(d);
      setRows((current) => [{ ...d, key: key++, fresh: !reducedMotion() }, ...current].slice(0, FEED_ROWS));
      if (!frame) frame = requestAnimationFrame(animate);
    };
    const pump = () => {
      while (active < DETAIL_CONCURRENCY && queue.length) {
        active++;
        void arrive(queue.shift()!)
          .catch(() => {})
          .finally(() => {
            active--;
            pump();
          });
      }
    };
    const onInsert = (id: string) => {
      window.clearTimeout(idle);
      idle = window.setTimeout(() => {
        modeRef.current = "replay";
        setMode("replay");
      }, LIVE_IDLE_MS);
      if (modeRef.current === "replay") {
        // From now on the stage shows only what is really arriving.
        modeRef.current = "live";
        dots.current = [];
        setRows([]);
        setMode("live");
      }
      queue.push(id);
      pump();
    };

    const start = () =>
      import("@/lib/supabase").then(({ browserSupabase }) => {
        const supabase = browserSupabase();
        if (cancelled || !supabase) return;
        // A new arrival gets its score row inserted; rescoring earlier rows only updates.
        const channel = supabase
          .channel("landing")
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "scores" }, (payload) => {
            const sid = (payload.new as { submission_id?: string }).submission_id;
            if (sid) onInsert(sid);
          })
          .subscribe();
        cleanup = () => void supabase.removeChannel(channel);
      });
    const idleCallback = "requestIdleCallback" in window;
    const handle = idleCallback ? window.requestIdleCallback(() => void start()) : window.setTimeout(() => void start(), 1500);
    return () => {
      cancelled = true;
      if (idleCallback) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
      window.clearTimeout(idle);
      cancelAnimationFrame(frame);
      cleanup?.();
    };
  }, []);

  const c = data?.counters;
  const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);
  const counters = [
    { id: "checked", value: c ? c.submissions.toLocaleString("en-US") : "—", label: "interviews checked" },
    { id: "fakes", value: c ? String(c.fabricated) : "—", label: "fakes planted" },
    { id: "caught", value: pct(c?.recall), label: "of fakes caught" },
    { id: "correct", value: pct(c?.precision), label: "of flags correct" },
  ];

  return (
    <section className="stage" aria-label="Submissions arriving and being checked">
      <div className="stagebar">
        <span className="dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="min-w-0 truncate">
          {data?.project.name ?? "Household Water Access Survey"} · {data?.project.region.split(",")[0] ?? "Kisumu"}, wave 2
        </span>
        <span data-testid="stage-mode" className={`stage-mode ${mode === "live" ? "is-live" : ""}`}>
          {mode === "live" ? "Live" : data ? `Replay · ${fmtMonthDay(`${data.date}T12:00:00Z`, "UTC")}` : "Replay"}
        </span>
      </div>
      <div className="stagegrid">
        <div ref={wrap} className="stagecanvas">
          <Image
            src={theme === "linear" ? basemapImage : basemapLightImage}
            alt=""
            fill
            preload
            sizes="(max-width: 960px) 100vw, 620px"
            className="object-cover"
          />
          <canvas ref={canvas} aria-hidden />
          <Glass as="span" className="stage-pill glass-tint">
            Each dot is an interview arriving · orange means flagged
          </Glass>
          <span className="stage-attrib">
            {CREDITS.map((credit, i) => (
              <span key={credit.href}>
                {i > 0 && (i === CREDITS.length - 1 ? " Data from " : " ")}
                <a href={credit.href} target="_blank" rel="noreferrer">
                  {credit.text}
                </a>
              </span>
            ))}
          </span>
        </div>
        <div className="feed" aria-live="off" data-testid="stage-feed">
          {rows.map((r) => (
            <div key={r.key} className={`frow ${r.fresh ? "is-new" : ""}`}>
              <span className="id">
                {shortId(r.id)} · {r.code}
              </span>
              <span className={`what ${r.fired.length ? "" : "text-muted"}`}>
                {r.fired.length ? r.fired.map((k) => CHECK_TITLE[k]).join(" · ") : "All checks passed"}
              </span>
              {r.flagged ? (
                <span className={`st ${r.score >= 5 ? "st-crit" : "st-warn"}`}>
                  <span>Review</span>
                </span>
              ) : (
                <span className="st st-ok">
                  <span>Passed</span>
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="counters">
        {counters.map((k) => (
          <div key={k.id}>
            <b data-testid={`counter-${k.id}`}>{k.value}</b>
            <span>{k.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
