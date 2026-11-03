// Two themes: "poket" (light, the default) and "linear" (the original dark theme). The theme is the
// data-theme attribute on <html>, set before first paint by THEME_SCRIPT and remembered in
// localStorage; every colour, font and glass value it switches lives in app/globals.css.
// Plain constants, so the root layout (a server component) can use them; the hooks are in lib/theme.ts.

export const THEMES = ["poket", "linear"] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "poket";
export const THEME_KEY = "fqc-theme";
/** Browser chrome colour (meta theme-color) per theme: the page background. */
export const THEME_COLOR: Record<Theme, string> = { poket: "#f8faf5", linear: "#08090a" };

/** Runs in <head> before the body paints, so a stored theme never flashes the default. */
export const THEME_SCRIPT = `(function(){var t;try{t=localStorage.getItem(${JSON.stringify(THEME_KEY)})}catch(e){}
if(t!=="linear")t="poket";document.documentElement.dataset.theme=t;
document.addEventListener("DOMContentLoaded",function(){var m=document.querySelector('meta[name="theme-color"]');
if(m)m.content=${JSON.stringify(THEME_COLOR)}[t]})})()`;
