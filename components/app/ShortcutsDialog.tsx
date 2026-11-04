"use client";

import { useEffect, useRef } from "react";

import { Glass } from "@/components/ui/Glass";

const KEYS: [string[], string][] = [
  [["1", "2", "3", "4"], "Overview, Queue, Detectors, Test"],
  [["J", "K"], "Next, previous"],
  [["A"], "Approve"],
  [["B"], "Back-check"],
  [["R"], "Reject"],
  [["U"], "Undo"],
  [["E"], "Open all evidence"],
  [["D"], "Demo controls"],
  [["?"], "Shortcuts"],
  [["Esc"], "Close"],
];

/** Every keyboard shortcut in one place (key ?), so no screen has to spell them out. */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-(--modal-scrim) px-4" onClick={onClose}>
      <Glass
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        className="glass-tint w-full max-w-[340px] rounded-xl p-4 outline-none"
        data-testid="shortcuts"
      >
        <h2 className="mb-3 text-[14px] font-semibold">Shortcuts</h2>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-[12.5px]">
          {KEYS.map(([keys, label]) => (
            <div key={label} className="contents">
              <dt className="flex gap-1">
                {keys.map((k) => (
                  <kbd key={k} className="kbd">
                    {k}
                  </kbd>
                ))}
              </dt>
              <dd className="text-ink-2">{label}</dd>
            </div>
          ))}
        </dl>
      </Glass>
    </div>
  );
}
