# Themes

Two themes, switched in the sidebar footer and remembered per browser (`localStorage` key `fqc-theme`):

- **Poket** (light, the default): Poket's own palette and fonts, read from poketapp.com.
- **Linear** (dark): the original prototype theme (`design/prototype.html`), unchanged.

Every colour, font and glass value is a token in `app/globals.css`: the Poket values sit in `@theme` and `:root`, and `html[data-theme="linear"]` restores the dark ones. `lib/theme-config.ts` holds the theme names and the script that sets `data-theme` before first paint. `lib/theme.ts` has `useTheme`, `setTheme`, and `cssColor`, which MapLibre and the landing canvas use because they cannot read `var()`.

## What poketapp.com uses

Read on 2026-11-03 with Playwright from the live page's computed styles, at 1440 and 390 wide. The site is built with Framer. The reference screenshots are `data/screens/poket-ref-home-{1440,390}[-full].png`. Nothing was copied from it: no logo, illustration or photo.

| Role | Value | Where on the page |
|---|---|---|
| Page background | `#FFFFFF` | `body` background |
| Off-white surfaces | `#F7F7F7`, `#FAFAFA`, `#F4F4F4`, `#F8FAF5`, `#F0F2F6` | Framer colour tokens on `:root` |
| Input fill | `rgba(187,187,187,0.15)` | contact form fields |
| Brand green | `#039B6E` | h1 "Turn Field Data into Action", "Request a Demo" button, footer column headings |
| Brand green (cards) | `#039A6B` | feature cards, the form's Submit button |
| Green tints | `#CCE8E0`, `#BADED4`, `#039C6E2B` (17%) | Framer tokens; the pale feature card |
| Green light / dark | `#1EC79A` / `#156949` | Framer tokens |
| Heading text | `#000000` | section h2 and h3 ("How it works", "Collect data") |
| Body text | `#000000` | hero paragraph |
| Secondary text | `rgba(0,0,0,0.6)` | nav links, footer links, "Poket is trusted by…" |
| Greys (tokens) | `#171717`, `#181D27`, `#414651`, `#535862`, `#6D6D6D` | Framer tokens |
| Other accents | orange `#D4611F` (`#F4DACB`, `#7C340B`), magenta `#D01D92` (`#991F6E`), red `#F23731`, blue `#4686FE` | Framer tokens, used in illustrations |
| Borders | `1px #EEEEEE`, `2px #E6E6E6`, token `#00000014` (8% black) | chat input and Send button, the rewards card |
| Shadows | `inset 0 2px 1px rgba(207,231,255,0.2)`, `inset 0 1px 1px #FFF` | green feature cards, the translucent white card |
| Blur | `backdrop-filter: blur(10px)` on `rgba(255,255,255,0.95)` | floating panel |
| Gradient | `radial-gradient(50% 50% at 93.7% 8.1%, rgba(184,199,217,0.5), transparent)` | section glow |
| Radius | 100px and 80px (pill buttons), 20px and 16px (cards), 8px (logos, small cards), 22px (inputs) | |
| Display font | **Jost** 600, 79px, letter-spacing −0.03em | h1 |
| Headings | Jost 400 and 500, 39–56px, −0.03em ("Jost Variable" for the 48px statement) | h2, h3 |
| Body and UI | Jost 400, 16–20px; nav 500, 14px; footer headings 600, 15px | |
| Also loaded | Inter 400, Open Runde 600 (one button label), DM Mono 500, Fragment Mono 400, Material Icons | `document.fonts` |

**Fonts and licences.** Jost and DM Mono come from Google Fonts (`fonts.gstatic.com/s/jost`, `/s/dmmono`) under the SIL Open Font License 1.1. We load both with `next/font/google`, so nothing needed substituting. Jost covers display and body text; DM Mono, which Poket also loads, covers IDs and numbers. Open Runde (OFL, not on Google Fonts) labels one Poket button and isn't needed here.

## Poket theme tokens

| Token | Value | From |
|---|---|---|
| `bg` | `#F8FAF5` | Poket's green-tinted off-white token, so white panels read as panels |
| `panel` | `#FFFFFF` | Poket's page background |
| `raised` | `#F7F7F7` | Poket surface token |
| `line` / `line-strong` | 8% / 15% black | Poket's `#00000014`; the strong one for inputs and buttons |
| `ink` | `#171717` | Poket token, 17.9:1 on white |
| `ink-2`, `body` | `#414651` | Poket token |
| `muted` | `#535862` | Poket token, 7.1:1 |
| `faint` | `#62666D` | Poket's 60% black as a solid grey that keeps 4.5:1 on every surface, glass included |
| `accent` | `#039B6E` | Poket brand: focus rings, selected bars, the chart's precision line, the live-phone ring, the landing h1 (large text, 3.4:1 against the 3:1 rule) |
| `accent-ink` | `#027A56` | **Derived**: the same green, darkened to 5.4:1, for links, small labels and the primary button. Poket's white on `#039B6E` is 3.5:1, below AA at our 12–14px |
| `accent-soft` | 10% brand | like Poket's `#039C6E2B` tint (selected options on the phone) |
| `overlay` | brand | selected rows and tabs tint 6–14% brand |
| `ok` (passed, genuine) | `#1E7B34` | ours: a leaf green (hue 133°, the brand is 162°), 5.3:1, kept apart from the brand |
| `warn` (flagged) | `#A15C00` | amber darkened to 5.2:1 (Linear's `#F0A23B` is 2.0:1 on white) |
| `crit` (critical) | `#C42B1C` | red darkened to 5.7:1 (Poket's `#F23731` is 3.9:1) |
| `pass` | `#6D6D6D` | Poket token |
| `map` | `#F1F3EF` | the light basemap's ground |
| Fonts | Jost (sans, display), DM Mono (mono) | Poket |
| `font-size-adjust` | 0.5 | Jost's x-height is 0.46 em (Inter's 0.55), so at the dashboard's 11–13.5px it reads small. It's drawn about 9% larger, about as wide as Inter was. |
| Button radius | pill | Poket's buttons |
| Panel radius | 12px | between Poket's 8px small cards and 20px feature cards |

Status never relies on colour alone: dots and score tags keep their labels ("Flagged", "Review", "Passed", "Investigate").

**Light liquid glass** stays on the floating layer only: bars, map overlays, chips, tooltips, toasts and modals. It's translucent white (52–74%), with `blur(18px) saturate(180%)`, a bright inner top highlight, a masked specular edge that's white at 95% top-left and 60% bottom-right, and a soft low shadow plus a 0.5px hairline so it reads on white. Faint brand-green, mint and blue-grey glows (`--ambient`) sit behind the app, so the glass has something to show through. Without `backdrop-filter` it falls back to opaque white.

**Map.** The light theme uses OpenFreeMap's Positron style (free, no key, attribution kept), recoloured by `tuneLightBasemap` in `lib/basemap.ts`: a pale green-grey ground, soft blue water, and no neighbourhood names or road shields. Points, rings and chips use the semantic tokens. The landing page's pre-rendered map is `public/landing/basemap-light.webp`, from `node scripts/render-basemap.mjs --theme light`. The dark `basemap.webp` stays for Linear. Both use the same `basemap.json` bounds.

## Contrast check

```bash
node --env-file=.env.local scripts/contrast.mjs [base URL] [--theme poket|linear] [--result]
```

For each page state, the script records every visible text run with its colour, ancestor opacity, size and weight. It then hides all text, takes a screenshot, and measures each run against the pixels under it, so glass is tested over the map or content it actually covers. A run passes when its 5th-percentile ratio reaches WCAG AA: 4.5:1, or 3:1 for 24px+ or bold 18.66px+.

- Disabled controls are exempt, as in WCAG. Text covered by another element is skipped.
- States checked: `/`, `/app` with E07's hotspot open, `/app` with the demo panel open, the queue with E07's evidence, `/app/detectors`, `/architecture`, `/pitch` slide 4, and `/collect` (contributors and form).
- `--result` also submits one phone interview to check its result screen, then resets the demo.
- Output goes to `data/screens/contrast-<theme>.json`; the script exits 1 on any failure.
