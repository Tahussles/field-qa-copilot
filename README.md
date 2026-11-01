# Field QA Copilot

Checks field data submissions as they sync, flags likely fabrication with explainable evidence, queues flagged items for human review, and writes a daily brief for the lead researcher.

Next.js + FastAPI (Python 3.12) on Vercel, with Supabase for Postgres, Realtime and Storage.

```bash
pnpm install
uv sync
cp .env.example .env.local   # then fill in the values
git config core.hooksPath .githooks
pnpm dev                     # web on :3000, API on :8000
```

Health check: `GET /api/py/health`.
