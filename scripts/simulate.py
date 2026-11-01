"""Replay the seeded live day (Oct 31) against the API, the way phones sync.

    uv run scripts/simulate.py --target prod --reset-live
    uv run scripts/simulate.py --target local --speed 0 --limit 40
    uv run scripts/simulate.py --dry-run

Enumerators deliver in batches (back to back when they reach wifi at lunch or
in the evening); participants trickle in minutes after capture. --speed is
wall-clock seconds per field hour (default 6; 0 sends as fast as possible).
Ground truth for what is sent goes straight to synthetic_truth with the
service role key; it never passes through the API. After the run a few
submissions are re-sent to show retries are idempotent.
"""

import argparse
import json
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api._lib.postgrest import Supabase, load_env  # noqa: E402
from datagen import config as cfg  # noqa: E402
from datagen.live import api_payload, build_live_day  # noqa: E402

TARGETS = {"local": "http://127.0.0.1:8000/api/py", "prod": "https://field-qa-copilot.vercel.app/api/py"}
TRUTH_BATCH = 25


def actor_of(sub, live) -> str:
    if sub.device_id == live.wave.ring_device:
        return "ring device"
    if sub.contributor.code in cfg.FRAUD_ENUMERATORS or sub.contributor.code == live.wave.burst_account:
        return sub.contributor.code
    return "genuine " + sub.contributor.kind + "s"


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round(q * (len(ordered) - 1)))]


def post_with_retry(http: httpx.Client, body: dict) -> tuple[httpx.Response, float]:
    """Like a phone: retry on a busy lease (503) or a dropped connection, reusing the same client id."""
    for attempt in range(6):
        started = time.perf_counter()
        try:
            response = http.post("/submissions", json=body)
        except httpx.TransportError:
            time.sleep(1 + attempt)
            continue
        elapsed = (time.perf_counter() - started) * 1000
        if response.status_code != 503:
            return response, elapsed
        time.sleep(1 + attempt)  # another arrival holds the scoring lease
    response = http.post("/submissions", json=body)
    return response, 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=20261031)
    parser.add_argument("--target", choices=sorted(TARGETS), default="local")
    parser.add_argument("--speed", type=float, default=6.0, help="wall seconds per field hour (0 = no waiting)")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--dry-run", action="store_true", help="print the schedule; send nothing")
    parser.add_argument("--reset-live", action="store_true", help="delete source='simulator' rows first, then rescore")
    args = parser.parse_args()

    live = build_live_day(args.seed)
    events = live.submissions[: args.limit] if args.limit is not None else live.submissions
    if args.dry_run:
        for sub in events:
            print(f"{sub.synced_at.astimezone(cfg.EAT):%m-%d %H:%M:%S} sync  {sub.contributor.code:<4} "
                  f"captured {sub.captured_at.astimezone(cfg.EAT):%H:%M}  {sub.fraud_type or sub.noise_tag or ''}")
        print(f"{len(events)} submissions, {sum(s.is_fabricated for s in events)} fabricated")
        return 0

    env = load_env(ROOT / ".env.local")
    passcode = env.get("DEMO_PASSCODE")
    if not passcode:
        print("DEMO_PASSCODE must be set in .env.local", file=sys.stderr)
        return 1
    db = Supabase.from_env_file(ROOT / ".env.local")
    http = httpx.Client(base_url=TARGETS[args.target], timeout=60, headers={"X-Demo-Passcode": passcode})

    if args.reset_live:
        removed = db.count("submissions", "id", source="eq.simulator")
        db.delete("submissions", source="eq.simulator")  # cascades to results, scores, reviews and truth
        rescored = http.post("/rescore", timeout=300).json()
        print(f"reset: deleted {removed} simulator submissions; rescored {rescored['submissions']} "
              f"({rescored['flagged']} flagged) in {rescored['total_ms']} ms")
    if not events:
        return 0

    truth: list[dict] = []
    latencies: list[float] = []
    statuses: Counter = Counter()
    final_flag: dict[str, bool] = {}
    sent_ids: dict[str, object] = {}  # server id -> generator submission
    flips: Counter = Counter()
    flip_lines = 0
    log: list[dict] = []
    first_field = events[0].synced_at
    wall_start = time.monotonic()
    print(f"sending {len(events)} submissions to {TARGETS[args.target]} at {args.speed:g} s per field hour")

    def flush_truth() -> None:
        if truth:
            db.upsert("synthetic_truth", truth, on_conflict="submission_id")
            truth.clear()

    try:
        for n, sub in enumerate(events, start=1):
            if args.speed > 0:
                due = wall_start + (sub.synced_at - first_field).total_seconds() / 3600 * args.speed
                time.sleep(max(0.0, due - time.monotonic()))
            response, ms = post_with_retry(http, api_payload(sub))
            statuses[response.status_code] += 1
            if response.status_code not in (200, 201):
                print(f"  ! {sub.contributor.code} {response.status_code} {response.text[:200]}", file=sys.stderr)
                if response.status_code in (401, 422):
                    return 1
                continue
            latencies.append(ms)
            body = response.json()
            sent_ids[body["id"]] = sub
            final_flag[body["id"]] = body["flagged"]
            for change in body["changed"]:
                final_flag[change["submission_id"]] = change["flagged"]
                flips["to flagged" if change["flagged"] else "to not flagged"] += 1
                flips["on wave rows" if change["submission_id"] not in sent_ids else "on live rows"] += 1
            truth.append({"submission_id": body["id"], "is_fabricated": sub.is_fabricated,
                          "fraud_type": sub.fraud_type, "noise_tag": sub.noise_tag})
            if len(truth) >= TRUTH_BATCH:
                flush_truth()

            fired = "+".join(f["key"] for f in body["fired"]) or "-"
            flipped = ""
            if body["changed"]:
                flip_lines += 1
                flipped = "  flips " + ", ".join(
                    f"{c['submission_id'][:8]}->{'flagged' if c['flagged'] else 'cleared'}" for c in body["changed"][:4])
                if len(body["changed"]) > 4:
                    flipped += f" (+{len(body['changed']) - 4})"
            label = sub.fraud_type or (f"genuine/{sub.noise_tag}" if sub.noise_tag else "genuine")
            print(f"{n:>3} {sub.synced_at.astimezone(cfg.EAT):%H:%M} {body['id'][:8]} {sub.contributor.code:<4} "
                  f"score {body['score']:>4.1f} {body['band']:<7} {fired:<34} {ms:>5.0f} ms  [{label}]{flipped}")
            log.append({"n": n, "id": body["id"], "code": sub.contributor.code, "status": response.status_code,
                        "ms": round(ms, 1), "score": body["score"], "flagged": body["flagged"],
                        "fired": [f["key"] for f in body["fired"]], "changed": len(body["changed"]),
                        "rescored": body.get("rescored"), "truth": sub.fraud_type, "noise": sub.noise_tag})
    finally:
        flush_truth()

    # Retries are idempotent: re-send three delivered submissions.
    retry_statuses = []
    for server_id, sub in list(sent_ids.items())[:3]:
        response = http.post("/submissions", json=api_payload(sub))
        retry_statuses.append((response.status_code, response.json().get("id") == server_id))

    by_actor: dict[str, Counter] = defaultdict(Counter)
    for server_id, sub in sent_ids.items():
        row = by_actor[actor_of(sub, live)]
        row["sent"] += 1
        row["fabricated"] += sub.is_fabricated
        row["flagged"] += final_flag.get(server_id, False)
        row["flagged fabricated"] += final_flag.get(server_id, False) and sub.is_fabricated

    flagged = sum(final_flag.get(i, False) for i in sent_ids)
    print()
    print(f"sent {len(sent_ids)} ({dict(statuses)}), flagged {flagged}, flips {dict(flips)}, "
          f"responses with flips {flip_lines}")
    print(f"latency ms: first {latencies[0]:.0f}, p50 {statistics.median(latencies):.0f}, "
          f"p95 {percentile(latencies, 0.95):.0f}, max {max(latencies):.0f}")
    print(f"retries of already-sent submissions: {retry_statuses}  (status, same id)")
    print("by actor (final state):")
    for actor in sorted(by_actor, key=lambda a: (a.startswith("genuine"), a)):
        c = by_actor[actor]
        print(f"  {actor:<22} sent {c['sent']:>3}  fabricated {c['fabricated']:>3}  flagged {c['flagged']:>3}  "
              f"(of which fabricated {c['flagged fabricated']})")

    out = ROOT / "data" / "sim"
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"run-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{args.target}.json"
    path.write_text(json.dumps({
        "target": args.target, "seed": args.seed, "speed": args.speed, "statuses": dict(statuses),
        "latency_ms": {"first": latencies[0], "p50": statistics.median(latencies),
                       "p95": percentile(latencies, 0.95), "max": max(latencies)},
        "flips": dict(flips), "retries": retry_statuses,
        "by_actor": {a: dict(c) for a, c in by_actor.items()}, "events": log,
    }, indent=2) + "\n")
    print(f"log: {path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
