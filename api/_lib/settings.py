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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    local = ROOT / ".env.local"
    file_env = load_env(local) if local.exists() else {}

    def value(key: str) -> str | None:
        return os.environ.get(key) or file_env.get(key) or None

    return Settings(
        supabase_url=value("NEXT_PUBLIC_SUPABASE_URL"),
        service_key=value("SUPABASE_SERVICE_ROLE_KEY"),
        demo_passcode=value("DEMO_PASSCODE"),
        project_id=value("PROJECT_ID"),
    )
