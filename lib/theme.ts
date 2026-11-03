"use client";

import { useSyncExternalStore } from "react";

import { DEFAULT_THEME, THEME_COLOR, THEME_KEY, THEMES, type Theme } from "./theme-config";

export { THEMES, type Theme };

function current(): Theme {
  return document.documentElement.dataset.theme === "linear" ? "linear" : "poket";
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** The theme in use (lib/theme-config.ts); re-renders when it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, current, () => DEFAULT_THEME);
}

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // private mode: the choice lasts for this page only
  }
}

/** A colour token's value for the theme in use (for MapLibre and canvas, which cannot read var()). */
export function cssColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
