# Field QA Copilot

A prototype built for a job interview at Poket Inc (Toronto). Poket runs a mobile + web platform that NGOs and research groups use to collect field data: surveys, photos, voice notes and GPS. Contributors earn points per submission, and that reward model invites fabricated submissions.

Field QA Copilot checks every submission as it syncs, flags likely fabrication with explainable evidence, queues flagged items for human review, and writes a daily brief for the lead researcher.

## Fixed stack

- **Web**: Next.js (App Router) + TypeScript + Tailwind at the repo root: dashboard, landing page, and later a `/collect` phone page. Package manager: pnpm.
- **API and detection engine**: Python 3.12 FastAPI at `api/index.py`, deployed as a Vercel Python function. A Next.js rewrite sends `/api/py/:path*` to it (to uvicorn on `127.0.0.1:8000` in dev). Python deps are managed with uv (`pyproject.toml`, `uv.lock`, `.python-version`).
- **Data**: Supabase Postgres, Realtime and Storage (private `voice-notes` bucket).
- **Hosting**: Vercel. `vercel.json` bundles `engine/` into the Python function and pins functions to `yul1` (Montréal), next to the Supabase project in `ca-central-1`.
- **Later rounds**: the Claude API (contradiction checks and the daily brief) and ElevenLabs (voice transcription). All detection checks are plain code, never AI.

## Folder layout

```
app/                      Next.js routes and UI
api/index.py              FastAPI app; every route lives under /api/py
engine/                   Python package with the detection checks (engine.__version__)
datagen/                  seeded synthetic wave with planted fraud (never imported by engine/)
scripts/                  generate.py, simulate.py, evaluate.py (offline tooling)
tests/                    pytest suite
data/synthetic/           generator output: CSVs, summary.json, preview.png (gitignored)
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
uv run pytest                              # Python tests
uv run scripts/generate.py --seed 20261031 --reset   # rebuild the synthetic wave in Supabase
uv run scripts/generate.py --seed 20261031 --dry-run # local files only
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
- Detection code (`engine/`, `api/`) must never read the `synthetic_truth` table or import `datagen`. Only `scripts/evaluate.py` reads the truth. Tests enforce both.
- Synthetic data is deterministic: the same seed gives identical rows, ids included. Change the generator, not the rows.
- Keep checks deterministic and explainable: the same submission and config always give the same result, and every check stores `fired`, `weight` and human-readable `evidence`, stamped with `engine_version`.
- Schema changes go in a new numbered migration. Never edit a migration that has been applied.
