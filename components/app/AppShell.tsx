"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { AppDataProvider, useAppData } from "@/components/app/AppData";
import { DemoProvider, useDemo } from "@/components/app/DemoControls";
import { PasscodeProvider } from "@/components/app/Passcode";
import { ReadOnlyBanner } from "@/components/app/ReadOnlyBanner";
import { ShortcutsDialog } from "@/components/app/ShortcutsDialog";
import { ThemeToggle } from "@/components/app/ThemeToggle";
import { ToastProvider } from "@/components/app/Toasts";
import { Glass } from "@/components/ui/Glass";
import { Popover, PopoverItem } from "@/components/ui/Popover";
import { Tip } from "@/components/ui/Tip";
import { DEFAULT_TZ, fmtMonthDay } from "@/lib/format";

export const SECTIONS = [
  { href: "/app", label: "Overview", key: "1", icon: IconGrid },
  { href: "/app/queue", label: "Review queue", key: "2", icon: IconList },
  { href: "/app/detectors", label: "Detectors", key: "3", icon: IconBars },
  { href: "/app/test", label: "Test", key: "4", icon: IconPlus },
] as const;

// The keyboard-shortcut overlay (key ?), opened from the shell's menus too.
let openShortcuts: () => void = () => {};

function sectionFor(pathname: string) {
  return [...SECTIONS].reverse().find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`)) ?? SECTIONS[0];
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)));
}

/** Sidebar + sticky topbar app shell, as in design/prototype.html. The KPI strip is Overview's; other sections get a
 * one-line summary in the topbar. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <PasscodeProvider>
        <AppDataProvider>
          <DemoProvider>
            <Shortcuts />
            <div className="ambient" aria-hidden />
            <div className="relative z-10 min-h-screen md:grid md:grid-cols-[232px_minmax(0,1fr)]">
              <Suspense fallback={<SidebarFrame active={null} />}>
                <Sidebar />
              </Suspense>
              <div className="flex min-w-0 flex-col">
                <Suspense fallback={<TopbarFrame title="" />}>
                  <Topbar />
                </Suspense>
                <main className="flex-1 p-4 pb-24 md:p-5">
                  <ReadOnlyBanner />
                  {children}
                </main>
              </div>
            </div>
            <Suspense fallback={null}>
              <MobileNav />
            </Suspense>
            <ReconnectingPill />
          </DemoProvider>
        </AppDataProvider>
      </PasscodeProvider>
    </ToastProvider>
  );
}

function Shortcuts() {
  const router = useRouter();
  const { toggle } = useDemo();
  const [help, setHelp] = useState(false);
  const close = useCallback(() => setHelp(false), []);
  useEffect(() => {
    openShortcuts = () => setHelp(true);
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector("[aria-modal='true']")) return;
      if (event.key === "?") {
        event.preventDefault();
        setHelp(true);
        return;
      }
      if (event.key === "d" || event.key === "D") {
        event.preventDefault();
        toggle();
        return;
      }
      const section = SECTIONS.find((s) => s.key === event.key);
      if (section) {
        event.preventDefault();
        router.push(section.href);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, toggle]);
  return <ShortcutsDialog open={help} onClose={close} />;
}

function Sidebar() {
  const pathname = usePathname();
  return <SidebarFrame active={sectionFor(pathname).href} />;
}

/** "Oct 25 to 31" from the first and last submission on the map. */
function useFieldworkDates(): string | null {
  const { overview, map } = useAppData();
  return useMemo(() => {
    const points = map?.points ?? [];
    if (!points.length) return null;
    const tz = overview?.project.timezone ?? DEFAULT_TZ;
    let first = points[0].captured_at;
    let last = first;
    for (const p of points) {
      if (p.captured_at < first) first = p.captured_at;
      if (p.captured_at > last) last = p.captured_at;
    }
    const [m0, d0] = fmtMonthDay(first, tz).split(" ");
    const [m1, d1] = fmtMonthDay(last, tz).split(" ");
    return m0 === m1 ? `${m0} ${d0} to ${d1}` : `${m0} ${d0} to ${m1} ${d1}`;
  }, [map, overview]);
}

function SidebarFrame({ active }: { active: string | null }) {
  const { overview, live } = useAppData();
  const dates = useFieldworkDates();
  const pending = overview?.kpis.pending_review;
  return (
    <aside aria-label="Sections" className="frost-aside sticky top-0 hidden h-screen flex-col gap-1 px-2.5 py-3 md:flex">
      <div className="flex items-center gap-[9px] px-2 pt-1.5 pb-3 font-display font-semibold">
        <span className="logo" aria-hidden />
        Field QA
      </div>
      <div className="mb-1.5 border-b border-line px-2 pt-2 pb-2.5 text-[12.5px] font-medium text-ink">
        <Tip content={`${overview?.project.region.split(",")[0] ?? "Kisumu"}${dates ? ` · ${dates}` : ""}`} className="cursor-default">
          {overview?.project.name ?? "Household Water Access Survey"}
        </Tip>
      </div>
      <nav className="flex flex-col gap-0.5">
        {SECTIONS.map((s) => {
          const current = active === s.href;
          const count = s.href === "/app/queue" ? pending : undefined;
          return (
            <Link
              key={s.href}
              href={s.href}
              aria-current={current ? "page" : undefined}
              aria-keyshortcuts={s.key}
              className={`flex items-center gap-[9px] rounded-md px-2 py-1.5 font-medium ${
                current ? "bg-overlay/[0.06] text-ink" : "text-muted hover:bg-hover hover:text-ink"
              }`}
            >
              <s.icon className="h-[15px] w-[15px] flex-none" />
              {s.label}
              {count != null && <span className="ml-auto font-mono text-[11px] text-muted">{count}</span>}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto flex items-center gap-2 border-t border-line px-2 pt-2.5 pb-1">
        <LiveDot live={live} />
        <ShellMenu side="top" className="ml-auto" engine={overview?.engine_version} />
      </div>
    </aside>
  );
}

/** The shell's "⋯": theme, demo controls, shortcuts, the intro, the engine and what this is. */
function ShellMenu({ side, className, engine }: { side: "top" | "bottom"; className?: string; engine?: string }) {
  const demo = useDemo();
  return (
    <Popover label="Menu" side={side} align={side === "top" ? "right" : "right"} className={className} testId="shell-menu">
      {(close) => (
        <>
          <div className="px-2.5 py-1.5">
            <ThemeToggle />
          </div>
          <PopoverItem kbd="D" onClick={() => (close(), demo.toggle())}>
            Demo controls
          </PopoverItem>
          <PopoverItem kbd="?" onClick={() => (close(), openShortcuts())}>
            Shortcuts
          </PopoverItem>
          <Link href="/" className="rounded-md px-2.5 py-1.5 text-ink hover:bg-overlay/[0.08]">
            Intro
          </Link>
          <p className="mt-1 border-t border-line px-2.5 pt-2 pb-1 text-[11.5px] text-muted">
            Prototype for Poket · not official
            {engine && <span className="block font-mono">engine {engine}</span>}
          </p>
        </>
      )}
    </Popover>
  );
}

function LiveDot({ live }: { live: "connecting" | "live" | "reconnecting" | "offline" }) {
  const tone = live === "live" ? "st-ok" : live === "offline" ? "st-crit" : "st-warn";
  const label =
    live === "live" ? "Live updates on" : live === "connecting" ? "Connecting" : live === "reconnecting" ? "Reconnecting, polling every 3 s" : "Live updates off";
  return (
    <Tip content={label} className={`st ${tone} cursor-default`}>
      <span className="sr-only" data-testid="live-status">
        {label}
      </span>
    </Tip>
  );
}

/** While Realtime is down the data polls every 3 s; say so, small and out of the way. */
function ReconnectingPill() {
  const { live } = useAppData();
  if (live !== "reconnecting") return null;
  return (
    <Glass
      className="glass-tint fixed top-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1.5 text-[12px] text-ink-2"
      role="status"
      data-testid="reconnecting"
    >
      <span className="ai-spinner" aria-hidden /> Reconnecting… updating every 3 s
    </Glass>
  );
}

function Topbar() {
  const pathname = usePathname();
  return <TopbarFrame title={sectionFor(pathname).label} />;
}

function TopbarFrame({ title }: { title: string }) {
  const { overview } = useAppData();
  const demo = useDemo();
  return (
    <header className="frost-topbar sticky top-0 z-20 flex h-12 flex-none items-center justify-between gap-3 px-4 md:px-5">
      <h1 className="min-w-0 truncate font-sans text-[13.5px] font-medium tracking-normal">{title}</h1>
      <span className="flex flex-none items-center gap-2">
        {overview?.now_is_fixed && (
          <Tip content="The demo runs on a fixed field clock" className="chip cursor-default font-mono" >
            <span data-testid="field-time">
              <span className="hidden sm:inline">Field time · </span>
              {fieldTime(overview.now, overview.project.timezone)}
            </span>
          </Tip>
        )}
        <button type="button" onClick={demo.toggle} aria-expanded={demo.open} className="btn btn-sm font-sans md:hidden">
          Demo
        </button>
        <span className="md:hidden">
          <ShellMenu side="bottom" engine={overview?.engine_version} />
        </span>
      </span>
    </header>
  );
}

/** "Sat 31 Oct 08:00" on the project's clock. */
function fieldTime(iso: string, tz: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz }).replace(",", "");
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz });
  return `${day} ${time}`;
}

function MobileNav() {
  const pathname = usePathname();
  const active = sectionFor(pathname).href;
  return (
    <Glass as="nav" aria-label="Sections" className="glass-tint fixed inset-x-3 bottom-3 z-30 flex rounded-2xl p-1.5 md:hidden">
      {SECTIONS.map((s) => (
        <Link
          key={s.href}
          href={s.href}
          aria-current={active === s.href ? "page" : undefined}
          className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-[10.5px] ${
            active === s.href ? "bg-overlay/[0.08] text-ink" : "text-ink-2"
          }`}
        >
          <s.icon className="h-4 w-4" />
          {s.label.split(" ")[0]}
        </Link>
      ))}
    </Glass>
  );
}

// Icons: the prototype's 16px line set. --------------------------------------------------

type IconProps = { className?: string };
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6 } as const;

function IconGrid({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden {...stroke}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  );
}
function IconList({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden {...stroke}>
      <path d="M2 4h12M2 8h12M2 12h8" />
    </svg>
  );
}
function IconBars({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden {...stroke}>
      <path d="M3 13V8M8 13V3M13 13v-7" />
    </svg>
  );
}
function IconPlus({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden {...stroke}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}
