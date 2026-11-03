"""Point the database's job hook (pg_net, migration 0007) at the API.

    uv run scripts/set_job_hook.py                                   # JOB_HOOK_URL (env or .env.local)
    uv run scripts/set_job_hook.py --url https://<deployment>.vercel.app

The URL comes from JOB_HOOK_URL, never from code: the production base URL.
Preview deployments are read-only (WRITES_ENABLED), so they refuse /jobs/run.

Stores the base URL and the shared X-Jobs-Secret in Supabase Vault through
set_job_hook(). The secret is derived from the service role key
(api/_lib/ai.jobs_secret), so the API checks it without another environment
variable. Rotating the service key means running this again. Prints no secret.
"""

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api._lib.ai import jobs_secret  # noqa: E402
from api._lib.postgrest import Supabase, load_env  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", help="the API's base URL (default: JOB_HOOK_URL)")
    args = parser.parse_args()
    local = ROOT / ".env.local"
    args.url = args.url or os.environ.get("JOB_HOOK_URL") or (load_env(local) if local.exists() else {}).get("JOB_HOOK_URL")
    if not args.url:
        print("set JOB_HOOK_URL (in .env.local) or pass --url", file=sys.stderr)
        return 2
    db = Supabase.from_env_file(local)
    db.rpc("set_job_hook", {"hook_url": args.url.rstrip("/"), "hook_secret": jobs_secret(db.service_key)})
    print(f"job hook now POSTs new ai_jobs to {args.url.rstrip('/')}/api/py/jobs/run")
    return 0


if __name__ == "__main__":
    sys.exit(main())
