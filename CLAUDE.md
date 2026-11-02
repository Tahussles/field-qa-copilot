# Field QA Copilot

A prototype built for a job interview at Poket Inc (Toronto). Poket runs a mobile + web platform that NGOs and research groups use to collect field data: surveys, photos, voice notes and GPS. Contributors earn points per submission, and that reward model invites fabricated submissions.

Field QA Copilot checks every submission as it syncs, flags likely fabrication with explainable evidence, queues flagged items for human review, and writes a daily brief for the lead researcher.

## Fixed stack

- **Web**: Next.js (App Router) + TypeScript + Tailwind at the repo root: dashboard, landing page, and later a `/collect` phone page. Package manager: pnpm.
- **API and detection engine**: Python 3.12 FastAPI at `api/index.py`, deployed as a Vercel Python function. A Next.js rewrite sends `/api/py/:path*` to it (to uvicorn on `127.0.0.1:8000` in dev). Python deps are managed with uv (`pyproject.toml`, `uv.lock`, `.python-version`).
- **Data**: Supabase Postgres, Realtime and Storage (private `voice-notes` bucket).
- **Hosting**: Vercel. `vercel.json` bundles `engine/` and `datagen/` (the demo replays its live day) into the Python function and pins functions to `yul1` (Montréal), next to the Supabase project in `ca-central-1`.
- **Later rounds**: the Claude API (contradiction checks and the daily brief) and ElevenLabs (voice transcription). All detection checks are plain code, never AI.

## Folder layout

```
design/prototype.html     the approved design (static, fake data); the dashboard matches its look
app/                      Next.js routes: / landing, /app overview, /app/queue[/id], /app/detectors, /app/test
  globals.css             design tokens (@theme), .glass and other component classes (@layer components)
components/               UI: app/ (shell, data provider, toasts, passcode, demo controls), overview/, queue/,
                          detectors/, test/, landing/ (stage), ui/Glass
lib/                      API client and types, formatting, check labels and colours, basemap palette, Supabase client
tests-e2e/                Playwright smoke test (playwright.config.ts at the root)
public/vendor/            MapLibre worker copied from node_modules before dev and build (gitignored)
public/landing/           pre-rendered stage basemap (webp) and its bounds and areas (json), committed
api/index.py              FastAPI routes, all under /api/py (docs at /api/py/docs)
api/_lib/                 Repository (Supabase + in-memory), service logic, schemas, /evaluate, demo controls
                          (underscore: Vercel does not turn these files into functions)
engine/                   detection engine: stdlib only, no I/O (engine.__version__)
  config.py               Params defaults; check_config.params merges over them
  model.py                Submission, Contributor, CheckResult, Context
  checks/                 one module per check: check(target, context) -> CheckResult
  scoring.py              score_all (batch) and score_incremental (live arrivals)
  insights.py             hotspots, contributor stats, area rates
  metrics.py              precision/recall against labels the caller supplies
datagen/                  seeded synthetic wave with planted fraud (may import engine, never the reverse)
scripts/                  generate.py, score.py, evaluate.py, simulate.py, verify_wave.py, realtime-probe.mjs,
                          vendor-maplibre.mjs, render-basemap.mjs
tests/                    pytest suite
data/synthetic/           generator output: CSVs, summary.json, preview.png (gitignored)
data/eval/                evaluation output: report.md, report.json (gitignored)
data/sim/                 simulator run logs (gitignored)
data/screens/             dashboard screenshots (gitignored)
supabase/migrations/      SQL migrations, numbered and applied in order
.githooks/commit-msg      rejects attribution strings in commit messages
.github/workflows/        attribution-guard CI check on every push and PR
vercel.json               function bundling and region
```

## Local development

```bash
pnpm install
uv sync
pnpm dev                                   # Next.js on :3000 and FastAPI on :8000
curl http://localhost:3000/api/py/health   # {"ok":true,"engine_version":"..."}
pnpm typecheck && pnpm lint                # TypeScript and ESLint
pnpm test:smoke                            # Playwright smoke test against the local app (reads prod data;
                                           # approve-then-undo needs DEMO_PASSCODE and SUPABASE_SERVICE_ROLE_KEY:
                                           # its reviews use reviewer 'smoke-test' and teardown deletes them)
SMOKE_BASE_URL=https://field-qa-copilot.vercel.app pnpm test:smoke   # same test against prod
uv run pytest                              # Python tests
uv run scripts/generate.py --seed 20261031 --reset   # rebuild the synthetic wave in Supabase
uv run scripts/generate.py --seed 20261031 --dry-run # local files only
uv run scripts/score.py                              # score the project, upsert check_results and scores
uv run scripts/evaluate.py                           # local precision/recall report, no database
uv run scripts/evaluate.py --tuning-only --param 'same_spot_radius_m=30'   # try a change on seeds 1-5
uv run scripts/simulate.py --target local --speed 0 --limit 40   # replay the Oct 31 live day via the API
uv run scripts/simulate.py --target prod --reset-live            # full live day against production
uv run scripts/verify_wave.py                        # is the database exactly the fresh wave? (after a demo reset)
node scripts/render-basemap.mjs                      # re-render public/landing/basemap.* (areas or palette changed)
node --env-file=.env.local scripts/realtime-probe.mjs 600        # watch Realtime events
```

Python deps: anything `api/` or `engine/` needs at runtime goes in `[project] dependencies`. Generator and test tools live in the `datagen` and `dev` dependency groups, which `uv sync` installs locally but Vercel does not.

After cloning, wire the commit hook once: `git config core.hooksPath .githooks`.

## Git rules (non-negotiable)

- Commits are authored by Taha only, using the existing git config. Never change `user.name`, `user.email` or `core.hooksPath`, never pass `--author`, never set `GIT_AUTHOR_*` or `GIT_COMMITTER_*`.
- No `Co-Authored-By` lines, no AI or assistant trailers, and no mention of Claude, Anthropic or AI generation in commit messages, PR bodies or code comments.
- Never use `--no-verify` or `-n`. If the commit-msg hook rejects a message, fix the message and retry.
- Never force-push or rewrite history unless Taha asks.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`) that describe the change, not the tool that made it.
- The hook and CI match those strings case-insensitively, so a commit message cannot name this file. Call it "project guide".
- CI (`attribution-guard`) fails any push or PR containing a commit whose message has those strings or whose author email is not `173319783+Tahussles@users.noreply.github.com`.

## Round-based workflow

- Work happens in numbered rounds. Each round's brief is the spec.
- Do only the current round. Do not start later rounds or build ahead of them.
- When the round's acceptance criteria are met, stop and report: links and IDs, deviations from the spec and why, proof that it works, the commit list, and anything that needs a human.

## Conventions

- Secrets live only in `.env.local`, which is never committed. `.env.example` lists the keys with empty values. Vercel holds the deployed values.
- The browser uses the anon key and can only read. All writes go through the server with the service role key.
- `engine/` never reads ground truth or imports `datagen`. In `api/`, only the /evaluate path (`api/_lib/evaluation.py` through `repo.truth_labels()`) reads `synthetic_truth`, server-side, and it returns aggregates only. `/demo/step` writes the generator's labels for what it sends (`repo.write_truth`) and never reads them. Scripts may read it (`evaluate.py`, `verify_wave.py`; `simulate.py` writes it). Tests enforce this.
- API: endpoints depend on the `Repository` interface, never on Supabase directly. Writes need the `X-Demo-Passcode` header (`DEMO_PASSCODE` in `.env.local` and on Vercel). Reads are public.
- Ingest is two database calls: `ingest_begin` (lease, idempotent insert, fetch the scoring context) and `ingest_commit` (fenced write of the results, release). SQL only fetches and writes; every check and scoring decision stays in Python.
- Leases (`scoring_locks`) cover every contributor and device whose results an arrival can read or change, expire after 15 s, and are fenced: a commit after its lease expired writes nothing. A retry of a stored submission that has no score, or one from an older engine_version, heals it and its affected set.
- Review queue: score >= review_threshold. Watch band: watch_threshold <= score < review_threshold, counted and filterable, never queued.
- Synthetic data is deterministic: the same seed gives identical rows, ids included. Change the generator, not the rows.
- Evaluation seeds: tune defaults on seeds 1-5 only. Seeds 101-110 are held out for reporting and the CI gate; never tune on them. The demo seed is 20261031.
- A changed default needs its seeds 1-5 evidence in a code comment next to it (see same_spot in engine/config.py).
- Bump engine.__version__ when check logic changes; check_results are keyed by engine_version, and scores.config records the params used.
- Keep checks deterministic and explainable: the same submission and config always give the same result, and every check stores `fired`, `weight` and human-readable `evidence`, stamped with `engine_version`.
- Schema changes go in a new numbered migration. Never edit a migration that has been applied.
- `projects.as_of`, when set, is "now" for that project: today, yesterday and the brief anchor to it. The demo project is fixed at 2026-10-31 08:00 Africa/Nairobi.
- Contributor status: investigate = 3+ flagged and rate >= 15%; watch = 2+ flagged and rate >= 8%; otherwise ok (`engine/insights.py`).
- Main signal: the check that fired most for a contributor; ties go shared_device > same_spot > burst > copied_text > voice_vs_form > straight_lining > off_hours > too_fast. One function (`mainSignal` in `lib/checks.ts`) feeds the contributors table, the brief and the hotspot cards.
- Dashboard UI matches `design/prototype.html`: its tokens, glass recipe and component classes live in `app/globals.css`. Content panels are solid (`.panel`); only the floating layer (bars, map overlays, chips, tooltips, toasts, modals) uses `.glass` / `<Glass>`; add `.glass-tint` where small text sits over busy content. Without backdrop-filter, glass falls back to opaque. Custom classes live in `@layer components` so Tailwind utilities can override them.
- The dashboard reads with the publishable key and refreshes on Supabase Realtime events (debounced ~1 s), never by polling. Writes from the browser go through the API with `X-Demo-Passcode`.
- Map: MapLibre with the OpenFreeMap dark style (no key; attribution from the tile source), loaded after first paint behind a skeleton, with a preconnect to the tile host. Its worker is served from `public/vendor/` because a bundler moves the module it would otherwise resolve against.
- Demo controls (`/api/py/demo/*`, all behind the passcode): `reset` deletes simulator and live submissions with their dependents and every review, rescores the wave on the quiet path and sets `as_of` back to Oct 31 08:00; `step` sends the next pending live-day submissions (by client_submission_id, so repeats and two tabs are safe) through `service.ingest` and moves `as_of` forward; `status` lists progress and the key moments derived from the live day's fraud actors. The runner lives in the browser (`components/app/DemoControls.tsx`, D key); the rest of the app only reacts through Realtime. `verify_wave.py` proves a reset left the fresh wave.
- `as_of` is read fresh for the overview (`repo.as_of()`); the cached project context may hold an old value.
- Landing (`/`): no MapLibre. The stage draws on a canvas over `public/landing/basemap.webp`, replays yesterday's real submissions from `/api/py/landing` (CDN-cached), and says "Live" only while real score inserts arrive over Realtime. Reduced motion gets a static frame.
