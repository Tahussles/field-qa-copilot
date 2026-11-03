"""Runtime settings from the environment (Vercel), falling back to .env.local in local dev."""

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .postgrest import load_env

ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    supabase_url: str | None
    service_key: str | None
    demo_passcode: str | None
    project_id: str | None  # optional; otherwise the only project in the database
    # Seconds per Supabase request. Vercel (yul1) sits next to the database; a laptop
    # can be far slower, so local dev waits longer (reads also retry once).
    db_timeout: float
    anthropic_key: str | None
    elevenlabs_key: str | None
    # Ingest, reviews, demo controls and the job hook. On Vercel only where WRITES_ENABLED=true (Production),
    # so a preview deployment is a read-only view of the same database; off Vercel (local dev, tests) on.
    writes_enabled: bool
    commit: str | None  # the deployed git commit (Vercel sets it), for the post-deploy check


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    local = ROOT / ".env.local"
    file_env = load_env(local) if local.exists() else {}

    def value(key: str) -> str | None:
        return os.environ.get(key) or file_env.get(key) or None

    writes = value("WRITES_ENABLED")
    return Settings(
        supabase_url=value("NEXT_PUBLIC_SUPABASE_URL"),
        service_key=value("SUPABASE_SERVICE_ROLE_KEY"),
        demo_passcode=value("DEMO_PASSCODE"),
        project_id=value("PROJECT_ID"),
        db_timeout=20.0 if os.environ.get("VERCEL") else 45.0,
        anthropic_key=value("ANTHROPIC_API_KEY"),
        elevenlabs_key=value("ELEVENLABS_API_KEY"),
        writes_enabled=writes.lower() == "true" if writes else not os.environ.get("VERCEL"),
        commit=os.environ.get("VERCEL_GIT_COMMIT_SHA") or None,
    )
