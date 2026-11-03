# Field QA Copilot

A prototype built for a job interview at Poket Inc (Toronto). Poket runs a mobile + web platform that NGOs and research groups use to collect field data: surveys, photos, voice notes and GPS. Contributors earn points per submission, and that reward model invites fabricated submissions.

Field QA Copilot checks every submission as it syncs, flags likely fabrication with explainable evidence, queues flagged items for human review, and writes a daily brief for the lead researcher.

## Fixed stack

- **Web**: Next.js (App Router) + TypeScript + Tailwind at the repo root: dashboard, landing page and the `/collect` phone page. Package manager: pnpm.
- **API and detection engine**: Python 3.12 FastAPI at `api/index.py`, deployed as a Vercel Python function. A Next.js rewrite sends `/api/py/:path*` to it (to uvicorn on `127.0.0.1:8000` in dev). Python deps are managed with uv (`pyproject.toml`, `uv.lock`, `.python-version`).
- **Data**: Supabase Postgres, Realtime and Storage (private `voice-notes` bucket).
- **Hosting**: Vercel. `vercel.json` bundles `engine/` and `datagen/` (the demo replays its live day) into the Python function and pins functions to `yul1` (Montréal), next to the Supabase project in `ca-central-1`.
- **AI** (round 7): the Claude API (meaning checks with a Haiku-class model, the brief with a Sonnet-class model) and ElevenLabs (Scribe speech to text, text to speech). All detection checks stay plain code; see "AI layer" below. Keys: `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`.

## Folder layout

```
design/prototype.html     the approved design (static, fake data); the dashboard matches its look
app/                      Next.js routes: / landing, /app overview, /app/queue[/id], /app/detectors, /app/test,
                          /collect (the phone)
  globals.css             design tokens (@theme), .glass and other component classes (@layer components)
components/               UI: app/ (shell, data provider, toasts, passcode, demo controls), overview/, queue/,
                          detectors/, test/, landing/ (stage), collect/ (phone form, recorder, result), ui/Glass
lib/                      API client and types, formatting, check labels and colours, basemap palette, Supabase client;
                          collect/ (IndexedDB outbox, phone API calls, simulated and real locations)
tests-e2e/                Playwright: smoke, landing and demo on desktop; collect.spec.ts on Pixel and iPhone profiles
                          with a fake microphone (fixtures/pipe-dry.wav); playwright.config.ts at the root
public/vendor/            MapLibre worker copied from node_modules before dev and build (gitignored)
public/landing/           pre-rendered stage basemap (webp) and its bounds and areas (json), committed
api/index.py              FastAPI routes, all under /api/py (docs at /api/py/docs)
api/_lib/                 Repository (Supabase + in-memory), service logic, schemas, /evaluate, demo controls,
                          ai.py (every model call), jobs.py (ai_jobs runner), brief.py (facts and checks),
                          collect.py (collect tokens, voice-note paths)
                          (underscore: Vercel does not turn these files into functions)
engine/                   detection engine: stdlib only, no I/O (engine.__version__)
  config.py               Params defaults; check_config.params merges over them
  model.py                Submission, Contributor, CheckResult, Context
  checks/                 one module per check: check(target, context) -> CheckResult
  scoring.py              score_all (batch) and score_incremental (live arrivals)
  insights.py             hotspots, contributor stats, area rates
  metrics.py              precision/recall against labels the caller supplies
datagen/                  seeded synthetic wave with planted fraud (may import engine, never the reverse);
                          hard.py: hard-mode waves for evaluation only (tuning 211-212, held out 201-202);
                          edge_cases.py: the fixed world and schema for reviewed edge cases (GPS accuracy, phone
                          clocks, recorded verdicts and an expected band are optional per case)
scripts/                  generate.py, score.py, evaluate.py, simulate.py, verify_wave.py, backfill_ai.py,
                          set_job_hook.py, ai_models.py, refresh_ai_verdicts.py, eval_diff.py, gen_edge_cases.py,
                          realtime-probe.mjs, vendor-maplibre.mjs, render-basemap.mjs
tests/                    pytest suite
docs/                     ai-practices.md (how AI is used), decisions.md (key design decisions)
data/fixtures/            committed: ai_verdicts/ (recorded hard-mode model verdicts, CI scores from them),
                          edge_cases/proposed/ (model-proposed, awaiting review) and accepted/ (pytest runs them)
data/synthetic/           generator output: CSVs, summary.json, preview.png (gitignored)
data/eval/                evaluation output: report.md, report.json (gitignored); hard.json (committed)
data/sim/                 simulator run logs (gitignored)
data/screens/             dashboard screenshots (gitignored)
supabase/migrations/      SQL migrations, numbered and applied in order
.githooks/commit-msg      rejects attribution strings in commit messages
.github/workflows/        ci.yml (every PR and push to main), post-deploy.yml (after a Production deployment)
vercel.json               function bundling and region
```

## Local development

```bash
pnpm install
uv sync
pnpm dev                                   # Next.js on :3000 and FastAPI on :8000
curl http://localhost:3000/api/py/health   # {"ok":true,"engine_version":"..."}
pnpm typecheck && pnpm lint                # TypeScript (after next typegen) and ESLint
pnpm test:smoke                            # Playwright smoke test against the local app (reads prod data;
                                           # approve-then-undo needs DEMO_PASSCODE and SUPABASE_SERVICE_ROLE_KEY:
                                           # its reviews use reviewer 'smoke-test' and teardown deletes them)
SMOKE_BASE_URL=https://field-qa-copilot.vercel.app pnpm test:smoke   # same test against prod
pnpm exec playwright test --project=pixel --project=iphone   # the phone page (needs DEMO_PASSCODE; ends with a reset)
uv run pytest                              # Python tests
uv run scripts/generate.py --seed 20261031 --reset   # rebuild the synthetic wave in Supabase
uv run scripts/generate.py --seed 20261031 --dry-run # local files only
uv run scripts/score.py                              # score the project, upsert check_results and scores
uv run scripts/evaluate.py                           # local precision/recall report, no database
uv run scripts/evaluate.py --tuning-only --param 'same_spot_radius_m=30'   # try a change on seeds 1-5
uv run scripts/simulate.py --target local --speed 0 --limit 40   # replay the Oct 31 live day via the API
uv run scripts/simulate.py --target prod --reset-live            # full live day against production
uv run scripts/verify_wave.py                        # is the database exactly the fresh wave? (after a demo reset)
uv run scripts/ai_models.py                          # check the model ids against the providers' lists
uv run scripts/set_job_hook.py                       # point the database's job hook at JOB_HOOK_URL (production)
uv run scripts/backfill_ai.py --estimate             # model verdicts over the wave: cost first, then without --estimate
uv run scripts/evaluate.py --hard                    # rules only vs rules + AI on hard-mode waves (recorded verdicts)
uv run scripts/refresh_ai_verdicts.py --estimate     # re-record missing or stale verdicts (cost guard $5)
uv run scripts/gen_edge_cases.py --estimate          # propose edge cases (model calls); --review checks them
RUN_LIVE_AI=1 uv run pytest -k live                  # the one test that calls a real model (prompt injection)
node scripts/render-basemap.mjs                      # re-render public/landing/basemap.* (areas or palette changed)
node --env-file=.env.local scripts/realtime-probe.mjs 600        # watch Realtime events
```

Python deps: anything `api/` or `engine/` needs at runtime goes in `[project] dependencies`. Generator and test tools live in the `datagen` and `dev` dependency groups, which `uv sync` installs locally but Vercel does not.

After cloning, wire the commit hook once: `git config core.hooksPath .githooks`.

## AI layer (principles)

- Checks stay deterministic code. A model is used only for speech to text, judging meaning (voice vs form, reworded copies) and writing the brief (plus reading it aloud).
- The engine stays pure: model results are stored as inputs (`ai_verdicts`) that a check reads (`engine.Verdict`); with no verdict, the rule-based check stands. Same input, same output. Evidence records `decided_by` (`ai` / `ai_paraphrase` / `rules`). voice_vs_form uses a verdict only at confidence >= `ai_min_confidence` (0.7).
- Every model call (`api/_lib/ai.py`): strict structured output validated with pydantic, 12 s timeout, at most 3 attempts with backoff (the brief: regenerated once), then the rule or the template. Never block ingest: jobs are queued after the commit and a queueing failure is swallowed.
- Transcripts and answers are untrusted user data: wrapped in tags (look-alike tags neutralised), the system prompt says they are data only, and a verdict whose quote is not an exact substring of the transcript is rejected.
- Send only what's needed: contributor codes, never names. The brief gets aggregates only (`brief.facts`), and every number it writes must appear in them.
- Every `ai_jobs` row logs model, tokens, latency and estimated cost (`ai.PRICES`, ElevenLabs per hour / per character).
- Model ids live in `api/_lib/ai.py` (`JUDGE_MODEL`, `BRIEF_MODEL`, `SCRIBE_MODEL`, `TTS_MODEL`); check them with `scripts/ai_models.py`.
- Jobs: `ai_jobs` (queued, running, done, failed, skipped) with a unique `dedupe_key`, so queueing is idempotent and a finished job never reruns unless forced (`POST /jobs/{id}/rerun`). The database POSTs each new job to `/api/py/jobs/run` (pg_net trigger, migration 0007) with `X-Jobs-Secret` (in Vault, derived from the service key, set by `scripts/set_job_hook.py`); `/api/py/jobs/drain` (passcode) is the safety net. A verdict landing rescores through `service.rescore_submission` (the leased incremental path), so a score can change after arrival and Realtime tells the UI.
- The wave's verdicts (`scripts/backfill_ai.py`) are part of its fresh state: a demo reset keeps them and `verify_wave.py` scores the generated wave with the stored verdicts. `generate.py --reset` deletes them (cascade): re-run the backfill after.
- Hard mode (`datagen/hard.py`, never the demo seed) is the honest test: tune on seeds 211-212, report on held-out 201-202. `evaluate.py --hard` writes `data/eval/hard.json` (committed, aggregates only, served at `/api/py/eval/hard`) and never calls a model: it scores from the recorded verdicts in `data/fixtures/ai_verdicts/hard-<seed>.json`, keyed by kind, input hash, `PROMPT_VERSION` and model id and re-validated on load, and exits 2 on a missing or stale one. After a prompt or model change, `scripts/refresh_ai_verdicts.py` re-records only those (cost guard) and the files are committed. CI fails if `hard.json` does not match the code.
- A copy found only by the model (`decided_by: ai_paraphrase`) weighs `ai_paraphrase_weight` (1.5, below the review threshold): it corroborates, it never flags on its own.
- A deployment without a model key skips that job at once (`status: skipped`, no retries) and the rule-based result stands. The job hook posts to `JOB_HOOK_URL` (production), so jobs queued by a local ingest run there, with production's keys and engine. pg_cron (`resend-stale-job-hooks`, migration 0009) re-sends a hook for a job still queued 30 s to 10 min after it was created.
- Model prose (explanation, reason, form/voice summaries) is trimmed at a word boundary when long, never a failed verdict; decisions, confidence, quotes and the brief's numbers stay strict.
- Edge cases: `scripts/gen_edge_cases.py` gives a model each check's rule in plain words (never the code) and writes validated cases to `data/fixtures/edge_cases/proposed/`. A human reviews them (`--review` runs them through the engine); accepted ones move to `accepted/` and run in `tests/test_edge_cases.py`. A case the engine disagrees with is a wrong expectation (reject) or a real gap (report it; never bend the case to the code).
- `ai_jobs` outlive demo resets: `submission_id` is ON DELETE SET NULL and each job is stamped with its `demo_run_id`, so `ai_spend()` (shown in the demo panel) counts all time and this run.
- `transcript_lang` holds short codes: `en`, `sw`, `luo`.

## Git rules (non-negotiable)

- Commits are authored by Taha only, using the existing git config. Never change `user.name`, `user.email` or `core.hooksPath`, never pass `--author`, never set `GIT_AUTHOR_*` or `GIT_COMMITTER_*`.
- No `Co-Authored-By` lines, no AI or assistant trailers, and no mention of Claude, Anthropic or AI generation in commit messages, PR bodies or code comments.
- Never use `--no-verify` or `-n`. If the commit-msg hook rejects a message, fix the message and retry.
- Never force-push or rewrite history unless Taha asks.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`) that describe the change, not the tool that made it.
- The hook and CI match those strings case-insensitively, so a commit message cannot name this file. Call it "project guide".
- CI (`attribution-guard`, a job in `ci.yml`) fails any push to main or PR containing a commit whose message has those strings or whose author email is not `173319783+Tahussles@users.noreply.github.com`.
- Work goes through a branch and a PR so CI runs on it. When green, merge locally with `git merge --no-ff` and push; never GitHub's merge button (it stamps a private email).

## Round-based workflow

- Work happens in numbered rounds. Each round's brief is the spec.
- Do only the current round. Do not start later rounds or build ahead of them.
- When the round's acceptance criteria are met, stop and report: links and IDs, deviations from the spec and why, proof that it works, the commit list, and anything that needs a human.

## Conventions

- Secrets live only in `.env.local`, which is never committed. `.env.example` lists the keys with empty values. Vercel holds the deployed values; GitHub Actions secrets hold what post-deploy.yml needs (`DEMO_PASSCODE`, `SUPABASE_SERVICE_ROLE_KEY`; `NEXT_PUBLIC_SUPABASE_URL` is a repository variable).
- `WRITES_ENABLED`: on Vercel only Production sets it to `true`; a preview is a read-only view (every credentialed route answers 403, no brief is queued, a banner says so). Off Vercel it defaults to true. `/health` reports `writes` and the deployed `commit`.
- CI (`ci.yml`): python (pytest with no network and no keys), web (typecheck, lint, build), eval-gate (held-out precision >= 0.85, recall >= 0.97), hard-mode (from recorded verdicts), attribution-guard, and on PRs one eval-diff comment (`scripts/eval_diff.py`, per check and combined, PR vs main). post-deploy.yml: on a successful Production deployment (Vercel's commit status on main's tip, or deployment_status), the desktop Playwright tests against production, a demo reset, `verify_wave.py`, and an issue on failure.
- The browser uses the anon key and can only read. All writes go through the server with the service role key.
- `synthetic_truth` has no anon access. `ai_jobs` and `ai_verdicts` are readable by anon (Realtime drives the UI; they hold no ground truth).
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
- Main signal: the check that fired most for a contributor; ties go shared_device > same_spot > outside_area > burst > copied_text > voice_vs_form > straight_lining > off_hours > clock_skew > too_fast. One function (`mainSignal` in `lib/checks.ts`) feeds the contributors table, the brief and the hotspot cards.
- Dashboard UI matches `design/prototype.html`: its tokens, glass recipe and component classes live in `app/globals.css`. Content panels are solid (`.panel`); only the floating layer (bars, map overlays, chips, tooltips, toasts, modals) uses `.glass` / `<Glass>`; add `.glass-tint` where small text sits over busy content. Without backdrop-filter, glass falls back to opaque. Custom classes live in `@layer components` so Tailwind utilities can override them.
- The dashboard reads with the publishable key and refreshes on Supabase Realtime events (debounced ~1 s), never by polling. Writes from the browser go through the API with `X-Demo-Passcode`.
- Map: MapLibre with the OpenFreeMap dark style (no key; attribution from the tile source), loaded after first paint behind a skeleton, with a preconnect to the tile host. Its worker is served from `public/vendor/` because a bundler moves the module it would otherwise resolve against.
- Demo controls (`/api/py/demo/*`, all behind the passcode): `reset` deletes simulator and live submissions with their dependents and every review, rescores the wave on the quiet path and sets `as_of` back to Oct 31 08:00; `step` sends the next pending live-day submissions (by client_submission_id, so repeats and two tabs are safe) through `service.ingest` and moves `as_of` forward; `status` lists progress and the key moments derived from the live day's fraud actors. The runner lives in the browser (`components/app/DemoControls.tsx`, D key); the rest of the app only reacts through Realtime. `verify_wave.py` proves a reset left the fresh wave.
- `as_of` is read fresh for the overview (`repo.as_of()`); the cached project context may hold an old value.
- Landing (`/`): no MapLibre. The stage draws on a canvas over `public/landing/basemap.webp`, replays yesterday's real submissions from `/api/py/landing` (CDN-cached), and says "Live" only while real score inserts arrive over Realtime. Reduced motion gets a static frame.
- Phone (`/collect`): opens with a collect token from the demo panel's QR code (`<expiry>.<demo run>.<HMAC>`, keyed from the service key, 30 min, revoked by a demo reset) or the passcode; nothing else. A token can only write `source: live` submissions whose voice note sits under `live/<its device_id>/`. The phone keeps a `device_id` in localStorage, saves each interview to an IndexedDB outbox first (audio included), then uploads the voice note to a signed Storage URL and POSTs `/submissions` with its own `client_submission_id`, so a retry returns the same record. Switching contributor on one phone is real and fires shared_device.
- Phone location is simulated by default (a new household inside the contributor's area, or the last interview's spot); "Use my real GPS" sends the real fix, so outside_area fires anywhere but Kisumu.
- Field clock (migration 0010): while `projects.as_of` is set, a `source: live` submission's `captured_at` and `synced_at` are mapped onto the field clock, `as_of + (real time - projects.clock_set_at)` (a trigger stamps `clock_set_at` whenever `as_of` changes), never past the field's "now"; the phone's own time is stored in `device_captured_at`. With `as_of` null the phone's time is used as is. The simulator and the demo step already send field times and are not mapped.
- outside_area fires only when the GPS point is outside the contributor's assigned area by more than max(gps_accuracy_m, 15 m); within 1 km it weighs 1.5 (corroboration: GPS tails at a boundary household), beyond it 2.0. Evidence: distance, accuracy, tolerance, band, area. The synthetic waves never place a point outside its area, so it is unmeasured there; the evidence for the tolerance and the bands is next to the params in `engine/config.py`.
- straight_lining fires on 8 identical answers or a strict two-value zig-zag; looser patterns fire on ~260 genuine forms per tuning seed and are not used.
- voice_vs_form's keyword rule matches whole words (plurals count; 'pumpkins', 'lakeside', 'upstream' do not) and 'buy from' says vendor only when no source is named. Meaning-level contradictions without a source keyword are deliberately left to the model verdict.
- clock_skew (engine 0.5.0, weight 1.5, corroboration only): the phone sends `device_synced_at` (its clock when it sends) and the server stamps `received_at`; more than 5 minutes apart, or a capture time after receipt, fires it. A late sync never does. Evidence: skew in minutes, direction, basis. Only live phones send a clock (migration 0011), so the synthetic waves cannot measure it; hard mode's night forger sets the phone back 3 h (`datagen/hard.py`), and `hard.json` reports clock_skew off vs on. Captures up to a day ahead are accepted and flagged, not refused.
- The phone's hidden "Demo controls" section has "Phone clock off by 3 h" (`lib/collect/clock.ts`, localStorage): every time the phone reports then runs 3 h behind.
