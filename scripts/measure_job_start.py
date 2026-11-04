"""How long a phone's model work waits to start on production: queued -> running, for every job.

    uv run scripts/measure_job_start.py            # 30 phone-style interviews with a voice note, then a demo reset
    uv run scripts/measure_job_start.py --n 10

Each interview uploads the voice-note fixture and syncs like a phone, so it queues a transcription, which
queues the voice-vs-form check. A job starts three ways: the API runs it right after the ingest response, the
database hook POSTs it, and the cron sweep re-sends a hook still queued after 10 s; this measures what a
phone sees. Writes data/eval/job_start.json (committed: aggregates only). About $0.02 of model calls. Ends
with a demo reset and verify_wave.py.
"""

import argparse
import json
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api._lib.postgrest import Supabase, load_env  # noqa: E402
from scripts.measure import pct  # noqa: E402
from scripts.preflight import PROD, VOICE_NOTE, Preflight  # noqa: E402

OUT = ROOT / "data" / "eval" / "job_start.json"


def stats(values: list[float]) -> dict:
    return {"n": len(values), "p50_s": round(pct(values, 0.5), 2), "p95_s": round(pct(values, 0.95), 2),
            "max_s": round(max(values), 2)} if values else {"n": 0}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--n", type=int, default=30)
    parser.add_argument("--gap", type=float, default=1.5, help="seconds between interviews")
    parser.add_argument("--base", default=PROD)
    parser.add_argument("--out", type=Path, default=OUT, help="where to write the report")
    args = parser.parse_args()
    env = load_env(ROOT / ".env.local")
    pf = Preflight(args.base, env)
    db = Supabase(env["NEXT_PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"], timeout=30)

    ids, ingest = [], []
    for i in range(args.n):
        client_id = f"jobstart-{uuid.uuid4()}"
        device = f"phone-jobstart{uuid.uuid4().hex[:8]}"
        signed = pf.http.post(f"{pf.api}/collect/upload", headers=pf.auth, json={
            "device_id": device, "client_submission_id": client_id, "content_type": "audio/wav"}).raise_for_status().json()
        pf.http.put(signed["upload_url"], content=VOICE_NOTE.read_bytes(),
                    headers={"content-type": "audio/wav", "x-upsert": "true"}).raise_for_status()
        body = pf.live_body(client_id, device, voice_note_path=signed["path"])
        sent = time.perf_counter()
        stored = pf.http.post(f"{pf.api}/submissions", json=body, headers=pf.auth).raise_for_status().json()
        ingest.append(time.perf_counter() - sent)  # the phone's wait: starting the jobs must not add to it
        ids.append(stored["id"])
        print(f"  {i + 1:2}/{args.n} {stored['id'][:8]} queued {[j['kind'] for j in stored.get('ai_jobs', [])]}", flush=True)
        time.sleep(args.gap)

    # Wait for every job (transcribe, then the voice check it queues) to finish.
    deadline = time.time() + 180
    while True:
        rows = db.select("ai_jobs", "submission_id,kind,status,created_at,started_at,finished_at",
                         submission_id=f"in.({','.join(ids)})")
        kinds = {(r["submission_id"], r["kind"]) for r in rows}
        done = all(r["status"] in ("done", "failed", "skipped") for r in rows)
        if (done and len({k for k in kinds if k[1] == "consistency"}) >= len(ids)) or time.time() > deadline:
            break
        time.sleep(2)

    def wait(r: dict) -> float | None:
        if not r.get("started_at"):
            return None
        parse = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))  # noqa: E731
        return (parse(r["started_at"]) - parse(r["created_at"])).total_seconds()

    waits = {kind: [w for r in rows if r["kind"] == kind and (w := wait(r)) is not None] for kind in ("transcribe", "consistency")}
    everything = [w for r in rows if (w := wait(r)) is not None]
    report = {
        "measured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "base": args.base,
        "submissions": len(ids),
        "jobs": len(rows),
        "not_started": sum(1 for r in rows if not r.get("started_at")),
        "statuses": {s: sum(1 for r in rows if r["status"] == s) for s in sorted({r["status"] for r in rows})},
        "wait": {"all": stats(everything), **{k: stats(v) for k, v in waits.items()}},
        "ingest_round_trip": stats(ingest),
    }
    args.out.write_text(json.dumps(report, indent=1) + "\n")
    for name, s in {**report["wait"], "ingest": report["ingest_round_trip"]}.items():
        if s["n"]:
            print(f"{name:12} n={s['n']:3}  p50 {s['p50_s']:.2f} s  p95 {s['p95_s']:.2f} s  max {s['max_s']:.2f} s")
    print(f"statuses {report['statuses']} · not started {report['not_started']} · {args.out}")

    reset = pf.http.post(f"{pf.api}/demo/reset", headers=pf.auth, timeout=180).raise_for_status().json()
    print(f"demo reset: removed {reset['deleted']['submissions']} live submissions")
    return subprocess.run(["uv", "run", "scripts/verify_wave.py"], cwd=ROOT).returncode


if __name__ == "__main__":
    sys.exit(main())
