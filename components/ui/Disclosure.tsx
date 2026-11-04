"use client";

import { useCallback, useId, useState, useSyncExternalStore, type ReactNode } from "react";

// Progressive disclosure (docs/decisions.md): a summary that always shows and details behind a real
// button (aria-expanded, Enter/Space), a rotating chevron and a height animation that reduced motion
// turns off. Section cards can remember whether they are open (localStorage `fqc-ui-<key>`).

const PREFIX = "fqc-ui-";
const memory = new Map<string, boolean>(); // when localStorage is blocked, the choice lasts for this page
const listeners = new Set<() => void>();

function readStored(key: string): boolean | null {
  if (memory.has(key)) return memory.get(key)!;
  try {
    const v = window.localStorage.getItem(PREFIX + key);
    return v == null ? null : v === "1";
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Open or closed, remembered per key in this browser (no key: not remembered). The third value says whether the
 * reader has chosen yet. */
export function useStoredOpen(key: string | null, initial: boolean): [boolean, (open: boolean) => void, boolean] {
  const stored = useSyncExternalStore(
    subscribe,
    () => (key ? readStored(key) : null),
    () => null,
  );
  const open = stored ?? initial;
  const set = useCallback(
    (next: boolean) => {
      if (!key) return;
      memory.set(key, next);
      try {
        window.localStorage.setItem(PREFIX + key, next ? "1" : "0");
      } catch {
        // private mode: memory keeps it
      }
      listeners.forEach((l) => l());
    },
    [key],
  );
  return [open, set, stored != null];
}

export function Chevron({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={`chev h-3.5 w-3.5 flex-none ${className}`} aria-hidden fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

/** The details: their height animates open and closed; closed, they leave the tab order and the accessibility tree. */
export function Reveal({ open, id, children, className = "" }: { open: boolean; id?: string; children: ReactNode; className?: string }) {
  return (
    <div id={id} className={`reveal ${className}`} data-open={open} inert={!open}>
      <div className="reveal-inner">{children}</div>
    </div>
  );
}

type SectionProps = {
  title: ReactNode;
  /** One line that always shows, next to the title (collapsed or not). */
  summary?: ReactNode;
  /** Controls on the right of the header strip. */
  actions?: ReactNode;
  children: ReactNode;
  /** Collapsible: give an initial state; storeKey remembers the reader's choice. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  storeKey?: string;
  /** Controlled open state (overrides the stored one). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  bodyClassName?: string;
  id?: string;
  "aria-label"?: string;
  "data-testid"?: string;
};

/**
 * A section card: 1px border, 12px radius, a tinted header strip with the title and its controls,
 * 16px padding. Collapsible ones put the title in a disclosure button.
 */
export function Section({
  title,
  summary,
  actions,
  children,
  collapsible = false,
  defaultOpen = true,
  storeKey,
  open: controlled,
  onOpenChange,
  className = "",
  bodyClassName = "p-4",
  id,
  ...rest
}: SectionProps) {
  const uid = useId();
  const [stored, setStored] = useStoredOpen(collapsible ? (storeKey ?? null) : null, defaultOpen);
  const [local, setLocal] = useState(defaultOpen);
  const open = !collapsible ? true : controlled ?? (storeKey ? stored : local);
  const toggle = () => {
    const next = !open;
    onOpenChange?.(next);
    if (controlled === undefined) (storeKey ? setStored : setLocal)(next);
  };
  const headingId = `${uid}-title`;
  const bodyId = `${uid}-body`;
  return (
    <section
      id={id}
      aria-labelledby={rest["aria-label"] ? undefined : headingId}
      aria-label={rest["aria-label"]}
      data-testid={rest["data-testid"]}
      data-open={open}
      className={`panel section ${className}`}
    >
      <div className="ph">
        <h2 id={headingId} className="min-w-0">
          {collapsible ? (
            <button type="button" className="disclosure" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
              <Chevron />
              {title}
            </button>
          ) : (
            title
          )}
        </h2>
        {summary != null && <span className="ph-caption min-w-0 flex-1 truncate">{summary}</span>}
        {actions && <div className={`flex flex-none items-center gap-1.5 ${summary == null ? "ml-auto" : ""}`}>{actions}</div>}
      </div>
      {collapsible ? (
        <Reveal open={open} id={bodyId}>
          <div className={bodyClassName}>{children}</div>
        </Reveal>
      ) : (
        <div className={bodyClassName}>{children}</div>
      )}
    </section>
  );
}
