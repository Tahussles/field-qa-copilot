"""Run the model's meaning checks over the stored wave, then rescore once.

    uv run scripts/backfill_ai.py --estimate     # count the calls and estimate the cost; no model call
    uv run scripts/backfill_ai.py                # run them (rate-limited), then one full rescore

Queues a consistency job for every synthetic submission with a transcript and
paraphrase jobs for candidate pairs (the same cheap filter as live arrivals,
capped per contributor). The jobs are queued with notify=false, so the database
hook leaves them alone and this script runs them with a few workers, skipping
the per-job rescore. One quiet rescore at the end applies every verdict.
Reports verdicts written, flags that changed and what it cost.

The wave's verdicts are part of its fresh state: a demo reset keeps them, and
scripts/verify_wave.py scores the generated wave with them.
"""

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api._lib import jobs, service  # noqa: E402
from api._lib.ai import JUDGE_MODEL, LiveProvider, token_cost  # noqa: E402
from api._lib.postgrest import Supabase, load_env  # noqa: E402
from api._lib.repo import SupabaseRepo  # noqa: E402

WORKERS = 6
PAIRS_PER_CONTRIBUTOR = 30
EST_TOKENS = {"consistency": (800, 350), "paraphrase": (450, 200)}


def planned_jobs(repo, params) -> list[dict]:
    rows = sorted(repo.submissions(source="synthetic"), key=lambda r: (r["captured_at"], r["id"]))
    planned, per_contributor = [], {}
    for i, row in enumerate(rows):
        job = jobs.consistency_job(row, notify=False)
        if job:
            planned.append({**job, "input": {**job["input"], "rescore": False}})
        if per_contributor.get(row["contributor_id"], 0) >= PAIRS_PER_CONTRIBUTOR:
            continue
        earlier = [o for o in rows[:i] if o["contributor_id"] == row["contributor_id"]
                   or (row.get("device_id") and o.get("device_id") == row["device_id"])]
        pairs = jobs.paraphrase_candidates(row, earlier, params, jobs.PARAPHRASE_PAIRS_PER_ARRIVAL)
        pairs = pairs[:PAIRS_PER_CONTRIBUTOR - per_contributor.get(row["contributor_id"], 0)]
        job = jobs.paraphrase_job(row, pairs, notify=False)
        if job:
            per_contributor[row["contributor_id"]] = per_contributor.get(row["contributor_id"], 0) + len(pairs)
            planned.append({**job, "input": {**job["input"], "rescore": False}})
    return planned


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--estimate", action="store_true")
    parser.add_argument("--max-usd", type=float, default=5.0)
    args = parser.parse_args()

    env = load_env(ROOT / ".env.local")
    repo = SupabaseRepo(Supabase.from_env_file(ROOT / ".env.local"))
    params = service.context(repo).params
    planned = planned_jobs(repo, params)
    calls = {"consistency": sum(j["kind"] == "consistency" for j in planned),
             "paraphrase": sum(len(j["input"]["pairs"]) for j in planned if j["kind"] == "paraphrase")}
    estimate = sum(n * token_cost(JUDGE_MODEL, *EST_TOKENS[k]) for k, n in calls.items())
    print(f"planned: {calls['consistency']} consistency calls, {calls['paraphrase']} paraphrase pairs "
          f"({len(planned)} jobs); estimated ${estimate:.2f}")
    if args.estimate:
        return 0
    if estimate > args.max_usd:
        print(f"stopping: over ${args.max_usd:.2f}", file=sys.stderr)
        return 3

    flagged_before = {s["submission_id"] for s in repo.scores() if s["flagged"]}
    verdicts_before = len(repo.verdicts())
    queued = repo.queue_jobs(planned)
    print(f"queued {len(queued)} new jobs")
    # Everything in the plan that has not finished, including jobs left by an interrupted run.
    keys = {j["dedupe_key"] for j in planned}
    open_jobs = [j for j in repo._db.select("ai_jobs", "id,dedupe_key,status", status="in.(queued,failed)",
                                            notify="is.false", project_id=f"eq.{repo.project()['id']}")
                 if j["dedupe_key"] in keys]
    provider = LiveProvider(env.get("ANTHROPIC_API_KEY") or None, None)
    started = time.monotonic()

    def run(job: dict) -> dict:
        if job["status"] == "failed":
            repo.requeue_job(job["id"])
        return jobs.run_job(repo, provider, job_id=job["id"])

    results = []
    with ThreadPoolExecutor(WORKERS) as pool:
        for n, result in enumerate(pool.map(run, open_jobs), start=1):
            results.append(result)
            if n % 100 == 0:
                print(f"  {n}/{len(open_jobs)} jobs, {time.monotonic() - started:.0f} s")
    rescored = service.rescore(repo)
    flagged_after = {s["submission_id"] for s in repo.scores() if s["flagged"]}
    spent = sum(float(r.get("cost_usd") or 0) for r in results)
    failed = [r for r in results if r["status"] != "done"]
    print(f"ran {len(results)} jobs in {time.monotonic() - started:.0f} s: {len(results) - len(failed)} done, "
          f"{len(failed)} failed; verdicts {verdicts_before} -> {len(repo.verdicts())}")
    print(f"rescore: {rescored['rows_written']} rows written; flagged {len(flagged_before)} -> {len(flagged_after)} "
          f"(+{len(flagged_after - flagged_before)} newly flagged, -{len(flagged_before - flagged_after)} cleared)")
    print(f"spent ${spent:.4f} (sum of ai_jobs.cost_usd for this run; {len(keys)} jobs in the plan)")
    for r in failed[:5]:
        print("  failed:", r["kind"], r["error"], file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
