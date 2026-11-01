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
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-20 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2 md:bottom-4"
      >
        {toasts.map((t) => (
          <Glass key={t.id} role="status" className="toast-in pointer-events-auto rounded-xl px-3.5 py-2.5">
            <div className="flex items-start gap-2.5">
              <span className={`dot mt-1.5 ${TONE_DOT[t.tone]}`} aria-hidden />
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-ink">{t.title}</p>
                {t.body && <p className="mt-0.5 text-xs text-muted">{t.body}</p>}
              </div>
            </div>
          </Glass>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
