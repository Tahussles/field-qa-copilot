"""FastAPI app. Deployed as a Vercel Python function; every route lives under /api/py."""

import sys
from pathlib import Path

# Put the repo root on sys.path so `engine` imports the same way under
# uvicorn locally and inside the Vercel function bundle.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import FastAPI  # noqa: E402

import engine  # noqa: E402

app = FastAPI(
    title="Field QA Copilot API",
    version=engine.__version__,
    docs_url="/api/py/docs",
    openapi_url="/api/py/openapi.json",
)


@app.get("/api/py/health")
def health() -> dict:
    return {"ok": True, "engine_version": engine.__version__}
