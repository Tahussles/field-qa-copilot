"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import { Glass } from "@/components/ui/Glass";

type Tone = "info" | "flag" | "ok" | "error";
interface Toast {
  id: number;
  title: string;
  body?: string;
  tone: Tone;
}

const ToastContext = createContext<(toast: Omit<Toast, "id">) => void>(() => {});

const TONE_DOT: Record<Tone, string> = {
  info: "bg-accent",
  flag: "bg-warn",
  ok: "bg-ok",
  error: "bg-crit",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = nextId.current++;
    setToasts((current) => [...current.slice(-3), { ...toast, id }]);
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 4800);
  }, []);

  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Bottom-centre glass pills, as in the prototype. */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-20 left-1/2 z-[60] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2 md:bottom-[18px]"
      >
        {toasts.map((t) => (
          <Glass
            key={t.id}
            role="status"
            className="toast-in pointer-events-auto flex max-w-full items-center gap-2 rounded-full px-4 py-2 text-[12.5px] text-ink"
          >
            <span className={`dot ${TONE_DOT[t.tone]}`} aria-hidden />
            <span className="truncate">
              {t.title}
              {t.body && <span className="text-muted"> · {t.body}</span>}
            </span>
          </Glass>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
