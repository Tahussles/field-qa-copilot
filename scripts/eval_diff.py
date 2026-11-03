"""The PR comment: detection precision and recall on held-out seeds, this branch vs main.

    uv run scripts/eval_diff.py --base base/report.json --head head/report.json \
        [--base-hard base/hard.json] [--head-hard head/hard.json] > comment.md

Reads the report.json that scripts/evaluate.py writes on each side (and hard.json
from evaluate.py --hard, when both sides have one). Prints markdown that starts
with a marker, so CI can find and update its one comment instead of adding more.
"""

import argparse
import json
import sys
from pathlib import Path

MARKER = "<!-- eval-diff -->"
SAME = 0.0005  # below a twentieth of a point, a change is noise


def mean(value):
    if isinstance(value, dict):
        return value.get("mean")
    return value


def pct(value) -> str:
    value = mean(value)
    return "n/a" if value is None else f"{100 * value:.1f}%"


def delta(before, after) -> str:
    before, after = mean(before), mean(after)
    if before is None or after is None:
        return "n/a" if before is None and after is None else "new" if before is None else "gone"
    change = after - before
    if abs(change) < SAME:
        return "= 0.0"
    return f"{'▲' if change > 0 else '▼'} {100 * change:+.1f} pts"


def verdict(before: dict, after: dict) -> str:
    """Better, worse, mixed or unchanged, from held-out combined precision and recall."""
    moves = [mean(after[m]) - mean(before[m]) for m in ("precision", "recall")]
    up = any(m >= SAME for m in moves)
    down = any(m <= -SAME for m in moves)
    if up and down:
        return "**Mixed**: one of precision and recall went up, the other down."
    if up:
        return "**Better**: detection improved on the held-out seeds."
    if down:
        return "**Worse**: detection got worse on the held-out seeds."
    return "**Unchanged**: detection is the same on the held-out seeds."


def row(label: str, before: dict, after: dict) -> str:
    return (f"| {label} | {pct(before['precision'])} | {pct(after['precision'])} | "
            f"{delta(before['precision'], after['precision'])} | {pct(before['recall'])} | "
            f"{pct(after['recall'])} | {delta(before['recall'], after['recall'])} |")


HEADER = ["| | precision main | precision PR | Δ | recall main | recall PR | Δ |", "|---|---|---|---|---|---|---|"]


def render(base: dict, head: dict, base_hard: dict | None, head_hard: dict | None, base_sha: str, head_sha: str) -> str:
    b, h = base["held_out"], head["held_out"]
    seeds = head["seeds"]["held_out"]
    lines = [
        MARKER,
        "### Detection eval: this PR vs main",
        "",
        verdict(b["combined"], h["combined"]),
        "",
        f"Held-out seeds {seeds[0]}–{seeds[-1]} (never tuned on), mean per seed, at review threshold "
        f"{head['params']['review_threshold']}. Engine {base['engine_version']} → {head['engine_version']}.",
        "",
        *HEADER,
        row("**combined**", b["combined"], h["combined"]),
    ]
    for key in head["held_out"]["per_check"]:
        before = b["per_check"].get(key) or {"precision": None, "recall": None}
        lines.append(row(f"`{key}`", before, h["per_check"][key]))
    lines += ["", "Per check: precision and recall of the check firing on its own; combined: flagged for review."]

    if head_hard:
        held = head_hard["seeds"]
        lines += ["", f"<details><summary>Hard mode (seeds {held[0]}–{held[-1]}, rules only and rules + AI from the "
                      "recorded verdicts)</summary>", "", *HEADER]
        for label, side in (("rules only", "rules"), ("rules + AI", "rules_ai")):
            before = base_hard[side]["combined"] if base_hard else {"precision": None, "recall": None}
            lines.append(row(label, before, head_hard[side]["combined"]))
        if not base_hard:
            lines += ["", "main has no recorded verdicts yet, so there is nothing to compare against."]
        lines += ["", "</details>"]

    lines += ["", f"<sub>{head_sha[:7]} vs main {base_sha[:7]} · scripts/evaluate.py · no model calls</sub>", ""]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--head", type=Path, required=True)
    parser.add_argument("--base-hard", type=Path)
    parser.add_argument("--head-hard", type=Path)
    parser.add_argument("--base-sha", default="")
    parser.add_argument("--head-sha", default="")
    args = parser.parse_args()

    def load(path: Path | None) -> dict | None:
        return json.loads(path.read_text()) if path and path.exists() else None

    print(render(load(args.base), load(args.head), load(args.base_hard), load(args.head_hard),
                 args.base_sha, args.head_sha))
    return 0


if __name__ == "__main__":
    sys.exit(main())
