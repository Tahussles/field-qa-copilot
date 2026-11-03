"""Score a project's submissions in Supabase and upsert check_results and scores.

    uv run scripts/score.py                      # the only project in the database
    uv run scripts/score.py --project-id <uuid>

Idempotent: re-running overwrites this engine version's check_results and each
submission's score. Results from other engine versions are kept.
"""

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine import Params, Submission, __version__, contributors_with_areas, score_all  # noqa: E402
from api._lib.postgrest import Supabase, SupabaseError  # noqa: E402

SUBMISSION_COLUMNS = "id,contributor_id,device_id,captured_at,synced_at,duration_sec,lat,lng,answers,voice_transcript"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project-id")
    args = parser.parse_args()

    try:
        db = Supabase.from_env_file(ROOT / ".env.local")
    except SupabaseError as error:
        print(error, file=sys.stderr)
        return 1

    try:
        projects = db.select("projects", "id,name,timezone", order="created_at")
        if args.project_id:
            projects = [p for p in projects if p["id"] == args.project_id]
        if len(projects) != 1:
            print(f"found {len(projects)} matching projects; pass --project-id", file=sys.stderr)
            return 1
        project = projects[0]
        project_filter = {"project_id": f"eq.{project['id']}"}

        started = time.perf_counter()
        config = db.select("check_config", "params", **project_filter)
        params = Params.from_config(config[0]["params"] if config else None, timezone=project["timezone"])
        contributors = contributors_with_areas(db.select("contributors", "id,code,kind,area_id", **project_filter),
                                               db.select("areas", "id,name,boundary", **project_filter))
        submissions = [Submission.from_row(r)
                       for r in db.select("submissions", SUBMISSION_COLUMNS, order="id", **project_filter)]
        loaded = time.perf_counter()

        scored = score_all(submissions, contributors, params)
        score_seconds = time.perf_counter() - loaded

        check_rows = [
            {"submission_id": s.submission_id, "check_key": r.key, "fired": r.fired, "weight": r.weight,
             "evidence": r.evidence, "engine_version": s.engine_version}
            for s in scored for r in s.results
        ]
        scored_at = datetime.now(timezone.utc).isoformat()
        score_rows = [
            {"submission_id": s.submission_id, "score": s.score, "flagged": s.flagged,
             "config": params.to_dict(), "engine_version": s.engine_version, "scored_at": scored_at}
            for s in scored
        ]
        db.upsert("check_results", check_rows, on_conflict="submission_id,check_key,engine_version")
        db.upsert("scores", score_rows, on_conflict="submission_id")
        total_seconds = time.perf_counter() - started

        in_project = {"submissions.project_id": f"eq.{project['id']}"}
        stored_checks = db.count("check_results", "submission_id,submissions!inner(project_id)",
                                 engine_version=f"eq.{__version__}", **in_project)
        stored_scores = db.count("scores", "submission_id,submissions!inner(project_id)", **in_project)
    finally:
        db.close()

    flagged = sum(s.flagged for s in scored)
    print(f"project {project['name']} ({project['id']}), timezone {project['timezone']}, engine {__version__}")
    print(f"scored {len(scored)} submissions in {score_seconds * 1000:.0f} ms "
          f"(load + score + write: {total_seconds:.1f} s); {flagged} flagged at threshold {params.review_threshold}")
    print(f"upserted {len(check_rows)} check_results and {len(score_rows)} scores; "
          f"stored for this project: {stored_checks} check_results (v{__version__}), {stored_scores} scores")
    return 0 if stored_checks == len(check_rows) and stored_scores == len(score_rows) else 1


if __name__ == "__main__":
    sys.exit(main())
