"use client";

import { setTheme, THEMES, useTheme } from "@/lib/theme";

const THEME_LABEL = { poket: "Poket", linear: "Linear" } as const;

/** Poket (light, the default) or Linear (dark); remembered in this browser. In the sidebar and the demo panel. */
export function ThemeToggle({ testId = "theme-toggle" }: { testId?: string }) {
  const theme = useTheme();
  const label = `${testId}-label`;
  return (
    <div className="flex items-center gap-2" data-testid={testId}>
      <span id={label} className="text-muted">
        Theme
      </span>
      <div role="radiogroup" aria-labelledby={label} className="ml-auto flex gap-0.5 rounded-full border border-line p-0.5">
        {THEMES.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={theme === t}
            onClick={() => setTheme(t)}
            className={`rounded-full px-2 py-px text-[11px] ${theme === t ? "bg-overlay/[0.1] text-ink" : "text-muted hover:text-ink"}`}
          >
            {THEME_LABEL[t]}
          </button>
        ))}
      </div>
    </div>
  );
}
