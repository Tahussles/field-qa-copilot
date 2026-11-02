"""Check that the database holds exactly the fresh demo wave: what generate.py --reset plus score.py leave.

    uv run scripts/verify_wave.py

Compares, row for row, the submissions, this engine version's check results and
the scores with the seeded wave scored in memory, and checks that nothing else
is left: no simulator or live rows, no reviews, the clock at Oct 31 08:00.
Exits 1 on any difference. Reads the database only.
"""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api._lib.postgrest import Supabase  # noqa: E402
from datagen import build_wave, db_rows  # noqa: E402
from datagen import config as cfg  # noqa: E402
from engine import Contributor, Params, Submission, __version__, score_all  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=20261031)
    args = parser.parse_args()

    db = Supabase.from_env_file(ROOT / ".env.local")
    rows = db_rows(build_wave(args.seed))
    project = rows["projects"][0]
    in_project = {"project_id": f"eq.{project['id']}"}
    joined = {"submissions.project_id": f"eq.{project['id']}"}
    problems: list[str] = []

    def expect(name: str, actual, wanted) -> None:
        ok = actual == wanted
        print(f"{'ok ' if ok else 'BAD'} {name}: {actual if not isinstance(actual, (dict, set)) else len(actual)}"
              + ("" if ok else f" (want {wanted if not isinstance(wanted, (dict, set)) else len(wanted)})"))
        if not ok:
            problems.append(name)

    config = db.select("check_config", "params", **in_project)
    params = Params.from_config(config[0]["params"] if config else None, timezone=project["timezone"])
    contributors = [Contributor.from_row(r) for r in rows["contributors"]]
    batch = score_all([Submission.from_row(r) for r in rows["submissions"]], contributors, params)

    stored = db.select("submissions", "id,client_submission_id,source,captured_at,duration_sec,lat,lng",
                       order="id", **in_project)
    expect("submissions (ids and client ids)", {(r["id"], r["client_submission_id"]) for r in stored},
           {(r["id"], r["client_submission_id"]) for r in rows["submissions"]})
    expect("simulator or live submissions", sum(r["source"] != "synthetic" for r in stored), 0)
    wanted_rows = {r["id"]: (r["duration_sec"], r["lat"], r["lng"]) for r in rows["submissions"]}
    expect("submission contents", {r["id"]: (r["duration_sec"], r["lat"], r["lng"]) for r in stored}, wanted_rows)

    scores = db.select("scores", "submission_id,score,flagged,engine_version,submissions!inner(project_id)", **joined)
    expect("scores", {s["submission_id"]: (s["score"], s["flagged"], s["engine_version"]) for s in scores},
           {s.submission_id: (s.score, s.flagged, s.engine_version) for s in batch})

    checks = db.select("check_results", "submission_id,check_key,fired,weight,evidence,submissions!inner(project_id)",
                       engine_version=f"eq.{__version__}", **joined)
    expect("check results", {(c["submission_id"], c["check_key"]): (c["fired"], c["weight"], c["evidence"]) for c in checks},
           {(s.submission_id, r.key): (r.fired, r.weight, r.evidence) for s in batch for r in s.results})

    expect("reviews", db.count("reviews", "id,submissions!inner(project_id)", **joined), 0)
    expect("ground-truth rows", db.count("synthetic_truth", "submission_id,submissions!inner(project_id)", **joined),
           len(rows["synthetic_truth"]))
    expect("projects.as_of", db.select("projects", "as_of", id=f"eq.{project['id']}")[0]["as_of"], cfg.PROJECT_AS_OF)

    flagged = sum(s.flagged for s in batch)
    print(f"\nfresh wave: {len(batch)} submissions, {flagged} flagged, engine {__version__}")
    if problems:
        print("differs: " + ", ".join(problems), file=sys.stderr)
        return 1
    print("the database matches a fresh generate + score")
    return 0


if __name__ == "__main__":
    sys.exit(main())
