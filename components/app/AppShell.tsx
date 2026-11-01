"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, type ReactNode } from "react";

import { AppDataProvider, useAppData } from "@/components/app/AppData";
import { PasscodeProvider } from "@/components/app/Passcode";
import { ToastProvider } from "@/components/app/Toasts";
import { Glass } from "@/components/ui/Glass";
import { fmtDateTime } from "@/lib/format";

export const SECTIONS = [
  { href: "/app", label: "Overview", key: "1", icon: IconGrid },
  { href: "/app/queue", label: "Review queue", key: "2", icon: IconInbox },
  { href: "/app/detectors", label: "Detectors", key: "3", icon: IconSliders },
  { href: "/app/test", label: "Test a submission", key: "4", icon: IconSend },
] as const;

function sectionFor(pathname: string) {
  return [...SECTIONS].reverse().find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`)) ?? SECTIONS[0];
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)));
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <PasscodeProvider>
        <AppDataProvider>
          <Shortcuts />
          <div className="ambient" aria-hidden />
          <div className="relative z-10 flex min-h-screen">
            <Suspense fallback={<SidebarFrame active={null} />}>
              <Sidebar />
            </Suspense>
            <div className="flex min-w-0 flex-1 flex-col md:pl-[244px]">
              <Suspense fallback={<TopbarFrame title="" />}>
                <Topbar />
              </Suspense>
              <main className="flex-1 px-4 pt-4 pb-24 md:px-6 md:pb-8">{children}</main>
            </div>
          </div>
          <Suspense fallback={null}>
            <MobileNav />
          </Suspense>
        </AppDataProvider>
      </PasscodeProvider>
    </ToastProvider>
  );
}

function Shortcuts() {
  const router = useRouter();
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector("[aria-modal='true']")) return;
      const section = SECTIONS.find((s) => s.key === event.key);
      if (section) {
        event.preventDefault();
        router.push(section.href);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
  return null;
}

function Sidebar() {
  const pathname = usePathname();
  return <SidebarFrame active={sectionFor(pathname).href} />;
}

function SidebarFrame({ active }: { active: string | null }) {
  const { overview, live } = useAppData();
  const pending = overview?.kpis.pending_review;
  return (
    <Glass
      as="aside"
      className="fixed inset-y-3 left-3 z-30 hidden w-[232px] flex-col rounded-2xl p-3 md:flex"
      aria-label="Sections"
    >
      <div className="flex items-center gap-2.5 px-2 pt-1 pb-4">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent/90 font-display text-[13px] font-bold text-white shadow-[0_0_24px_-4px_rgb(124_132_248/0.7)]">
          Q
        </span>
        <div className="min-w-0">
          <p className="truncate font-display text-[13px] font-semibold text-ink">Field QA Copilot</p>
          <p className="truncate text-[11px] text-muted">{overview?.project.region ?? "Kisumu, Kenya"}</p>
        </div>
      </div>
      <nav className="flex flex-col gap-0.5">
        {SECTIONS.map((s) => {
          const current = active === s.href;
          return (
            <Link
              key={s.href}
              href={s.href}
              aria-current={current ? "page" : undefined}
              className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors ${
                current ? "bg-white/[0.07] text-ink" : "text-muted hover:bg-white/[0.04] hover:text-ink"
              }`}
            >
              <s.icon className="h-4 w-4 flex-none opacity-80" />
              <span className="flex-1 truncate">{s.label}</span>
              {s.href === "/app/queue" && pending != null && pending > 0 && (
                <span className="rounded-md bg-warn/15 px-1.5 font-mono text-[10.5px] text-warn">{pending}</span>
              )}
              <kbd className="kbd opacity-0 transition-opacity group-hover:opacity-100">{s.key}</kbd>
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto space-y-2 px-2 pb-1 text-[11px] text-faint">
        <p className="leading-snug">{overview?.project.name ?? "Household Water Access Survey"}</p>
        <LiveBadge live={live} />
        {overview && <p className="font-mono">engine {overview.engine_version}</p>}
      </div>
    </Glass>
  );
}

function LiveBadge({ live }: { live: "connecting" | "live" | "offline" }) {
  const color = live === "live" ? "bg-ok" : live === "connecting" ? "bg-warn" : "bg-crit";
  const label = live === "live" ? "Live updates on" : live === "connecting" ? "Connecting…" : "Live updates off";
  return (
    <p className="flex items-center gap-1.5 text-muted">
      <span className={`dot ${color}`} aria-hidden />
      {label}
    </p>
  );
}

function Topbar() {
  const pathname = usePathname();
  return <TopbarFrame title={sectionFor(pathname).label} />;
}

function TopbarFrame({ title }: { title: string }) {
  const { overview } = useAppData();
  return (
    <Glass
      as="header"
      className="sticky top-3 z-20 mx-4 mt-3 flex h-12 items-center gap-3 rounded-xl px-4 md:mx-6"
    >
      <h1 className="font-display text-sm font-semibold text-ink">{title}</h1>
      <span className="hidden text-[13px] text-faint sm:inline">{overview?.project.name}</span>
      <div className="ml-auto flex items-center gap-3 text-[12px] text-muted">
        {overview?.now_is_fixed && (
          <span className="hidden items-center gap-1.5 sm:flex" title="The demo project runs on a fixed clock">
            <span className="dot bg-accent" aria-hidden />
            Project clock {fmtDateTime(overview.now, overview.project.timezone)}
          </span>
        )}
        <span className="rounded-md border border-line-strong px-1.5 py-0.5 text-[11px] text-muted">Synthetic data</span>
      </div>
    </Glass>
  );
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
            active === s.href ? "bg-white/[0.08] text-ink" : "text-ink-2"
          }`}
        >
          <s.icon className="h-4 w-4" />
          {s.label.split(" ")[0]}
        </Link>
      ))}
    </Glass>
  );
}

// Icons ----------------------------------------------------------------------------

type IconProps = { className?: string };
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function IconGrid({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden {...stroke}>
      <rect x="2" y="2" width="5" height="5" rx="1.2" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" />
    </svg>
  );
}
function IconInbox({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden {...stroke}>
      <path d="M2 9.5 3.6 3.4A1 1 0 0 1 4.6 2.6h6.8a1 1 0 0 1 1 .8L14 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9.5Z" />
      <path d="M2 9.5h3.2l.9 1.6h3.8l.9-1.6H14" />
    </svg>
  );
}
function IconSliders({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden {...stroke}>
      <path d="M3 4h10M3 8h10M3 12h10" />
      <circle cx="6" cy="4" r="1.4" fill="currentColor" />
      <circle cx="10.5" cy="8" r="1.4" fill="currentColor" />
      <circle cx="5" cy="12" r="1.4" fill="currentColor" />
    </svg>
  );
}
function IconSend({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden {...stroke}>
      <path d="M14 2 7 9M14 2l-4.5 12L7 9 2 6.5 14 2Z" />
    </svg>
  );
}
