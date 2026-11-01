"""Generate the synthetic survey wave and write it locally and to Supabase.

    uv run scripts/generate.py --seed 20261031 --reset   # replace this seed's project
    uv run scripts/generate.py --seed 20261031 --dry-run # local files only

The same seed always produces identical rows, ids included. Local files land
in data/synthetic/ (gitignored). Database writes use SUPABASE_SERVICE_ROLE_KEY
from .env.local.
"""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from datagen import build_wave, db_rows  # noqa: E402
from datagen.outputs import summarize, write_local  # noqa: E402
from supabase_rest import Supabase, SupabaseError  # noqa: E402

TABLES = ("projects", "areas", "contributors", "check_config", "submissions", "synthetic_truth")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=20261031)
    parser.add_argument("--reset", action="store_true", help="delete this seed's project (cascade) first")
    parser.add_argument("--dry-run", action="store_true", help="write local files only, no database")
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "synthetic")
    args = parser.parse_args()

    wave = build_wave(args.seed)
    rows = db_rows(wave)
    summary = summarize(wave, rows)
    for path in write_local(wave, rows, summary, args.out):
        print(f"wrote {path.relative_to(ROOT) if path.is_relative_to(ROOT) else path}")
    subs, fab = summary["submissions"], summary["fabricated"]
    print(f"seed {args.seed}: {subs['total']} submissions ({subs['enumerator']} enumerator, "
          f"{subs['participant']} participant), {fab['total']} fabricated ({fab['share_pct']}%)")

    if args.dry_run:
        return 0

    try:
        db = Supabase.from_env_file(ROOT / ".env.local")
    except SupabaseError as error:
        print(error, file=sys.stderr)
        return 1
    try:
        project_id = wave.project["id"]
        if db.count("projects", id=f"eq.{project_id}"):
            if not args.reset:
                print(f"project {project_id} already exists; rerun with --reset to replace it", file=sys.stderr)
                return 1
            db.delete("projects", id=f"eq.{project_id}")
            print(f"deleted project {project_id} and its rows")
        for table in TABLES:
            db.insert(table, rows[table])
            print(f"inserted {len(rows[table])} rows into {table}")
        stored = db.count("submissions", project_id=f"eq.{project_id}")
        if stored != len(rows["submissions"]):
            print(f"expected {len(rows['submissions'])} submissions in the database, found {stored}", file=sys.stderr)
            return 1
        print(f"verified {stored} submissions for project {project_id}")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
