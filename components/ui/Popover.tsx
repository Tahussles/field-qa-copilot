"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Glass } from "@/components/ui/Glass";

/**
 * A "⋯" button that opens a small floating panel of actions (the sidebar menu, the brief's menu).
 * Escape or a click outside closes it and focus returns to the button.
 */
export function Popover({
  label,
  children,
  align = "left",
  side = "bottom",
  className = "",
  testId,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  side?: "top" | "bottom";
  className?: string;
  testId?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  // "closed" (by an item or Escape) hands focus back to the button; a click elsewhere just closes.
  const [refocus, setRefocus] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setRefocus(true);
  }, []);

  useEffect(() => {
    if (open || !refocus) return;
    button.current?.focus();
    queueMicrotask(() => setRefocus(false));
  }, [open, refocus]);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("button, a, [tabindex]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open, close]);

  return (
    <div className={`relative ${className}`}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="btn btn-sm btn-ghost px-2 leading-none"
        data-testid={testId}
      >
        <span aria-hidden className="text-[15px] tracking-[0.08em]">
          ⋯
        </span>
      </button>
      {open && (
        <Glass
          ref={panel}
          id={id}
          role="group"
          aria-label={label}
          className={`glass-tint absolute z-50 flex w-60 flex-col gap-0.5 rounded-xl p-1.5 text-[12.5px] ${
            side === "top" ? "bottom-full mb-2" : "top-full mt-2"
          } ${align === "right" ? "right-0" : "left-0"}`}
        >
          {children(close)}
        </Glass>
      )}
    </div>
  );
}

/** One action in a popover. */
export function PopoverItem({ onClick, children, kbd }: { onClick: () => void; children: ReactNode; kbd?: string }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-ink hover:bg-overlay/[0.08]">
      {children}
      {kbd && <kbd className="kbd ml-auto">{kbd}</kbd>}
    </button>
  );
}
