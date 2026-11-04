"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Glass } from "@/components/ui/Glass";

const GAP = 8;
const EDGE = 8;

/**
 * A tooltip for any trigger: shown on hover (after a short delay) and on keyboard focus, hidden on
 * Escape, drawn in a portal so no scrolling list clips it. Screen readers get the same text through
 * aria-describedby on an always-present hidden copy.
 */
export function useTip(content: ReactNode, { delay = 250 }: { delay?: number } = {}) {
  const id = useId();
  const [at, setAt] = useState<{ x: number; top: number; bottom: number } | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const place = useCallback((el: Element) => {
    const r = el.getBoundingClientRect();
    setAt({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
  }, []);
  const hide = useCallback(() => {
    clear();
    setAt(null);
    setLeft(null);
  }, []);
  // Centre on the trigger, kept inside the window (measured once drawn).
  useLayoutEffect(() => {
    if (!at || !box.current) return;
    const w = box.current.offsetWidth;
    setLeft(Math.min(Math.max(at.x - w / 2, EDGE), window.innerWidth - w - EDGE));
  }, [at]);
  useEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
    };
  }, [at, hide]);
  useEffect(() => clear, []);

  const triggerProps = {
    "aria-describedby": `${id}-text`,
    onMouseEnter: (e: React.MouseEvent) => {
      const el = e.currentTarget;
      clear();
      timer.current = window.setTimeout(() => place(el), delay);
    },
    onMouseLeave: hide,
    onFocus: (e: React.FocusEvent) => place(e.currentTarget),
    onBlur: hide,
  };

  const below = at ? at.top < 120 : false;
  const tip = (
    <>
      <span id={`${id}-text`} hidden>
        {content}
      </span>
      {at &&
        createPortal(
          <Glass
            ref={box}
            role="tooltip"
            aria-hidden
            className="glass-tint tooltip pointer-events-none fixed z-[90]"
            style={{
              left: left ?? 0,
              visibility: left == null ? "hidden" : "visible",
              ...(below ? { top: at.bottom + GAP } : { bottom: window.innerHeight - at.top + GAP }),
            }}
          >
            {content}
          </Glass>,
          document.body,
        )}
    </>
  );
  return { triggerProps, tip };
}

/** A focusable trigger with a tooltip. */
export function Tip({ content, children, className = "" }: { content: ReactNode; children: ReactNode; className?: string }) {
  const { triggerProps, tip } = useTip(content);
  return (
    <>
      <span tabIndex={0} className={className} {...triggerProps}>
        {children}
      </span>
      {tip}
    </>
  );
}

/** How a finding was decided: "Rule" or "AI", with the method in a tooltip (what used to be a footnote). */
export function MethodChip({ ai, tip }: { ai: boolean; tip: ReactNode }) {
  return (
    <Tip content={tip} className={`method-chip ${ai ? "method-ai" : ""}`}>
      {ai ? "AI" : "Rule"}
    </Tip>
  );
}
