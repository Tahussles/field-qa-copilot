"""Measure production for the story pages: ingest latency, a phone interview end to end, model latency, spend.

    uv run scripts/measure.py             # 20 ingests and 3 voice interviews on production, then a demo reset
    uv run scripts/measure.py --ingests 40 --voice 5

Writes data/eval/measurements.json (committed, served at /api/py/story with the held-out headline and hard
mode), so /architecture and /pitch show measured numbers, never typed ones. Each voice interview costs
about $0.001 (one transcription, one judgment). Ends with a demo reset and verify_wave.py.
"""

import argparse
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api._lib.postgrest import Supabase, load_env  # noqa: E402
from engine import __version__  # noqa: E402
from scripts.preflight import PROD, Preflight  # noqa: E402

OUT = ROOT / "data" / "eval" / "measurements.json"


def pct(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round(q * (len(ordered) - 1)))]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ingests", type=int, default=20)
    parser.add_argument("--voice", type=int, default=3)
    parser.add_argument("--base", default=PROD)
    args = parser.parse_args()
    env = load_env(ROOT / ".env.local")
    p = Preflight(args.base, env)

    client, server, realtime = [], [], []
    while len(client) < args.ingests:
        _, sample = p.ingest_and_realtime(judge=False)  # 5 ingests each, the first with a Realtime round trip
        client += sample["client_ms"]
        server += sample["server_ms"]
        realtime.append(sample["realtime_ms"])
    voice = [p.voice_end_to_end()[1] for _ in range(args.voice)]

    db = Supabase.from_env_file(ROOT / ".env.local")
    jobs = db.select("ai_jobs", "kind,status,latency_ms,cost_usd")
    model = {}
    for kind in ("transcribe", "consistency", "paraphrase", "brief", "tts"):
        done = [j["latency_ms"] for j in jobs if j["kind"] == kind and j["status"] == "done" and j["latency_ms"]]
        if done:
            model[kind] = {"p50_ms": round(statistics.median(done)), "p95_ms": round(pct(done, 0.95)), "n": len(done)}
    measured = {
        "measured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "base": args.base,
        "engine_version": __version__,
        "ingest": {"n": len(client), "p50_ms": round(statistics.median(client)), "p95_ms": round(pct(client, 0.95)),
                   "api_p50_ms": round(statistics.median(server)), "api_p95_ms": round(pct(server, 0.95)),
                   "note": ("POST /submissions as a phone sends it, from Toronto to Vercel yul1; api_* is the API's own "
                            "timing (lease and insert, score, fenced commit, queue model work)")},
        "phone": {"n": len(voice), **{k: round(statistics.median([v[k] for v in voice]), 1)
                                      for k in ("rules_s", "transcript_s", "verdict_s")},
                  "note": "seconds from submit: the rules' result, the transcript (Scribe), the model's verdict (Claude)"},
        "realtime": {"n": len(realtime), "p50_ms": round(statistics.median(realtime)), "max_ms": max(realtime),
                     "note": "from POST /submissions to the INSERT arriving over Realtime (publishable key)"},
        "model_latency": model,
        "spend": {"usd": round(sum(float(j["cost_usd"] or 0) for j in jobs), 4), "jobs": len(jobs)},
    }
    OUT.write_text(json.dumps(measured, indent=2) + "\n")
    print(json.dumps({k: v for k, v in measured.items() if k in ("ingest", "phone", "spend")}, indent=1))
    p.check("demo reset", p.reset)
    p.check("verify_wave", p.verify_wave)
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0 if all(ok for ok, _, _ in p.results) else 1


if __name__ == "__main__":
    sys.exit(main())
