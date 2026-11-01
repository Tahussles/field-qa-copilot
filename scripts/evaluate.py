"""Evaluate the detection engine against synthetic ground truth, fully locally.

    uv run scripts/evaluate.py
    uv run scripts/evaluate.py --tuning-only --param 'same_spot_radius_m=30'   # explore on seeds 1-5
    uv run scripts/evaluate.py --min-precision 0.8 --min-recall 0.9          # CI gate

Generates waves in memory with datagen, scores them with the engine and
compares to the planted truth. No database. This is the only code that reads
the ground truth. Defaults may be tuned on TUNING_SEEDS only; HELD_OUT_SEEDS
are for reporting and the gate. Writes data/eval/report.json and report.md.
"""

import argparse
import json
import statistics
import sys
import time
from collections import Counter
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from datagen import build_wave, db_rows  # noqa: E402
from datagen.config import FRAUD_TYPES  # noqa: E402
from engine import CHECK_KEYS, Contributor, Params, Submission, __version__, score_all  # noqa: E402

DEMO_SEED = 20261031
TUNING_SEEDS = tuple(range(1, 6))
HELD_OUT_SEEDS = tuple(range(101, 111))
THRESHOLDS = tuple(1.0 + 0.5 * i for i in range(15))
NOISE_TAGS = ("short_genuine", "straightline_genuine", "two_source_transcript",
              "compound_cluster", "late_capture", "late_sync", "untagged")
COPY_METHODS = ("word_jaccard", "char_shingle")

# The fraud types each check is meant to catch.
TARGETS = {
    "too_fast": ("speeder", "burst"),
    "same_spot": ("curbstone", "night"),
    "copied_text": ("copypaste", "burst", "multi_account"),
    "straight_lining": ("speeder",),
    "voice_vs_form": ("contradiction",),
    "off_hours": ("night",),
    "shared_device": ("multi_account",),
    "burst": ("burst",),
}


def ratio(hits: int, total: int) -> float | None:
    return hits / total if total else None


def wave_inputs(seed: int):
    rows = db_rows(build_wave(seed))
    submissions = [Submission.from_row(r) for r in rows["submissions"]]
    contributors = [Contributor.from_row(r) for r in rows["contributors"]]
    truth = {t["submission_id"]: t for t in rows["synthetic_truth"]}
    return submissions, contributors, truth, rows["projects"][0]["timezone"]


def combined(scores: dict[str, float], truth: dict, threshold: float) -> dict:
    fakes = {sid for sid, t in truth.items() if t["is_fabricated"]}
    flagged = {sid for sid, score in scores.items() if score >= threshold}
    false_alarms = Counter(truth[sid]["noise_tag"] or "untagged" for sid in flagged - fakes)
    misses = Counter(truth[sid]["fraud_type"] for sid in fakes - flagged)
    return {
        "threshold": threshold,
        "submissions": len(scores),
        "fabricated": len(fakes),
        "flagged": len(flagged),
        "false_positives": len(flagged - fakes),
        "false_negatives": len(fakes - flagged),
        "precision": ratio(len(flagged & fakes), len(flagged)),
        "recall": ratio(len(flagged & fakes), len(fakes)),
        "false_alarms_by_cause": {tag: false_alarms.get(tag, 0) for tag in NOISE_TAGS},
        "misses_by_fraud_type": {ft: misses.get(ft, 0) for ft in FRAUD_TYPES},
    }


def per_check(scored, truth: dict) -> dict:
    fakes = {sid for sid, t in truth.items() if t["is_fabricated"]}
    fired = {key: set() for key in CHECK_KEYS}
    for s in scored:
        for r in s.results:
            if r.fired:
                fired[r.key].add(s.submission_id)
    out = {}
    for key, ids in fired.items():
        targeted = {sid for sid, t in truth.items() if t["fraud_type"] in TARGETS[key]}
        out[key] = {
            "fires_on": len(ids),
            "precision": ratio(len(ids & fakes), len(ids)),
            "recall": ratio(len(ids & fakes), len(fakes)),
            "targeted_recall": ratio(len(ids & targeted), len(targeted)),
        }
    return out


def run_seed(seed: int, params: Params) -> dict:
    submissions, contributors, truth, timezone = wave_inputs(seed)
    params = replace(params, timezone=timezone)
    started = time.perf_counter()
    scored = score_all(submissions, contributors, params)
    elapsed_ms = (time.perf_counter() - started) * 1000
    scores = {s.submission_id: s.score for s in scored}

    copy_methods = {}
    for method in COPY_METHODS:
        variant = scored if method == params.copy_method else score_all(
            submissions, contributors, replace(params, copy_method=method))
        copy_methods[method] = {
            "copied_text": per_check(variant, truth)["copied_text"],
            "combined": {k: v for k, v in combined({s.submission_id: s.score for s in variant}, truth,
                                                    params.review_threshold).items()
                         if k in ("precision", "recall", "flagged")},
        }
    return {
        "seed": seed,
        "score_ms": round(elapsed_ms, 1),
        "per_check": per_check(scored, truth),
        "combined": combined(scores, truth, params.review_threshold),
        "sweep": [{k: v for k, v in combined(scores, truth, t).items() if k in ("threshold", "precision", "recall", "flagged")}
                  for t in THRESHOLDS],
        "copy_methods": copy_methods,
    }


def stats(values) -> dict | None:
    values = [v for v in values if v is not None]
    if not values:
        return None
    return {"mean": statistics.fmean(values), "min": min(values), "max": max(values)}


def aggregate(runs: list[dict]) -> dict:
    return {
        "seeds": [r["seed"] for r in runs],
        "combined": {m: stats(r["combined"][m] for r in runs)
                     for m in ("precision", "recall", "flagged", "false_positives", "false_negatives", "fabricated")},
        "false_alarms_by_cause": {tag: stats(r["combined"]["false_alarms_by_cause"][tag] for r in runs) for tag in NOISE_TAGS},
        "misses_by_fraud_type": {ft: stats(r["combined"]["misses_by_fraud_type"][ft] for r in runs) for ft in FRAUD_TYPES},
        "per_check": {key: {m: stats(r["per_check"][key][m] for r in runs)
                            for m in ("fires_on", "precision", "recall", "targeted_recall")} for key in CHECK_KEYS},
        "sweep": [{"threshold": t, **{m: stats(r["sweep"][i][m] for r in runs) for m in ("precision", "recall", "flagged")}}
                  for i, t in enumerate(THRESHOLDS)],
        "copy_methods": {method: {
            "copied_text": {m: stats(r["copy_methods"][method]["copied_text"][m] for r in runs)
                            for m in ("fires_on", "precision", "recall", "targeted_recall")},
            "combined": {m: stats(r["copy_methods"][method]["combined"][m] for r in runs)
                         for m in ("precision", "recall", "flagged")},
        } for method in COPY_METHODS},
        "score_ms": stats(r["score_ms"] for r in runs),
    }


# Markdown ---------------------------------------------------------------------

def pct(value) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, dict):
        value = value["mean"]
    return f"{100 * value:.1f}%"


def pct_range(s: dict | None) -> str:
    return "n/a" if s is None else f"{100 * s['min']:.1f}–{100 * s['max']:.1f}%"


def num(value, digits: int = 1) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, dict):
        value = value["mean"]
    return f"{value:.{digits}f}" if isinstance(value, float) and not value.is_integer() else f"{value:.0f}"


def render_markdown(report: dict) -> str:
    demo, held, tuning = report["demo"], report["held_out"], report.get("tuning")
    params = report["params"]
    threshold = params["review_threshold"]
    lines = [
        f"# Engine evaluation (engine {report['engine_version']})",
        "",
        f"Review threshold {threshold}. Demo seed {DEMO_SEED}. Held-out seeds "
        f"{HELD_OUT_SEEDS[0]}–{HELD_OUT_SEEDS[-1]} (never used for tuning). Tuning seeds "
        f"{TUNING_SEEDS[0]}–{TUNING_SEEDS[-1]}. Copy method: {params['copy_method']}.",
        "",
        "## Combined at the review threshold",
        "",
        "| | precision | recall | flagged | false alarms | misses | fabricated |",
        "|---|---|---|---|---|---|---|",
        f"| demo seed | {pct(demo['combined']['precision'])} | {pct(demo['combined']['recall'])} | "
        f"{demo['combined']['flagged']} | {demo['combined']['false_positives']} | "
        f"{demo['combined']['false_negatives']} | {demo['combined']['fabricated']} |",
        f"| held-out mean | {pct(held['combined']['precision'])} | {pct(held['combined']['recall'])} | "
        f"{num(held['combined']['flagged'])} | {num(held['combined']['false_positives'])} | "
        f"{num(held['combined']['false_negatives'])} | {num(held['combined']['fabricated'])} |",
        f"| held-out range | {pct_range(held['combined']['precision'])} | {pct_range(held['combined']['recall'])} | "
        f"{held['combined']['flagged']['min']}–{held['combined']['flagged']['max']} | "
        f"{held['combined']['false_positives']['min']}–{held['combined']['false_positives']['max']} | "
        f"{held['combined']['false_negatives']['min']}–{held['combined']['false_negatives']['max']} | |",
    ]
    if tuning:
        lines.append(
            f"| tuning mean (1–5) | {pct(tuning['combined']['precision'])} | {pct(tuning['combined']['recall'])} | "
            f"{num(tuning['combined']['flagged'])} | {num(tuning['combined']['false_positives'])} | "
            f"{num(tuning['combined']['false_negatives'])} | {num(tuning['combined']['fabricated'])} |")

    lines += [
        "",
        "## Per check",
        "",
        "Recall is over all fabricated submissions; targeted recall is over the fraud types the check is meant to catch.",
        "",
        "| check | weight | targets | fires (demo) | precision demo / held-out | recall demo / held-out | targeted recall demo / held-out |",
        "|---|---|---|---|---|---|---|",
    ]
    for key in CHECK_KEYS:
        d, h = demo["per_check"][key], held["per_check"][key]
        lines.append(
            f"| {key} | {params['weights'][key]} | {', '.join(TARGETS[key])} | {d['fires_on']} | "
            f"{pct(d['precision'])} / {pct(h['precision'])} | {pct(d['recall'])} / {pct(h['recall'])} | "
            f"{pct(d['targeted_recall'])} / {pct(h['targeted_recall'])} |")

    lines += ["", "## False alarms by cause (flagged genuine submissions)", "",
              "| cause | demo | held-out mean | held-out range |", "|---|---|---|---|"]
    for tag in NOISE_TAGS:
        h = held["false_alarms_by_cause"][tag]
        lines.append(f"| {tag} | {demo['combined']['false_alarms_by_cause'][tag]} | {num(h)} | {h['min']}–{h['max']} |")

    lines += ["", "## Misses by fraud type (fabricated but not flagged)", "",
              "| fraud type | demo | held-out mean | held-out range |", "|---|---|---|---|"]
    for ft in FRAUD_TYPES:
        h = held["misses_by_fraud_type"][ft]
        lines.append(f"| {ft} | {demo['combined']['misses_by_fraud_type'][ft]} | {num(h)} | {h['min']}–{h['max']} |")

    lines += ["", "## Threshold sweep", "",
              "| threshold | precision demo / held-out | recall demo / held-out | flagged demo / held-out |",
              "|---|---|---|---|"]
    for d, h in zip(demo["sweep"], held["sweep"]):
        marker = " ←" if d["threshold"] == threshold else ""
        lines.append(f"| {d['threshold']:.1f}{marker} | {pct(d['precision'])} / {pct(h['precision'])} | "
                     f"{pct(d['recall'])} / {pct(h['recall'])} | {d['flagged']} / {num(h['flagged'])} |")

    lines += ["", "## copied_text: word Jaccard vs character 3-gram shingles", "",
              f"Both at copy_similarity {params['copy_similarity']}.", "",
              "| method | check precision demo / held-out | check recall demo / held-out | "
              "targeted recall demo / held-out | combined precision held-out | combined recall held-out |",
              "|---|---|---|---|---|---|"]
    for method in COPY_METHODS:
        d, h = demo["copy_methods"][method], held["copy_methods"][method]
        lines.append(
            f"| {method} | {pct(d['copied_text']['precision'])} / {pct(h['copied_text']['precision'])} | "
            f"{pct(d['copied_text']['recall'])} / {pct(h['copied_text']['recall'])} | "
            f"{pct(d['copied_text']['targeted_recall'])} / {pct(h['copied_text']['targeted_recall'])} | "
            f"{pct(h['combined']['precision'])} | {pct(h['combined']['recall'])} |")

    lines += ["", f"Scoring time: {demo['score_ms']:.0f} ms for the demo wave "
              f"({demo['combined']['submissions']} submissions).", ""]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--param", action="append", default=[], metavar="KEY=JSON",
                        help="override a default, e.g. same_spot_radius_m=30 or weights='{\"burst\": 3}'")
    parser.add_argument("--tuning-only", action="store_true", help="only run tuning seeds 1-5 (for exploring changes)")
    parser.add_argument("--min-precision", type=float, help="exit 1 if held-out mean precision is below this")
    parser.add_argument("--min-recall", type=float, help="exit 1 if held-out mean recall is below this")
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "eval")
    args = parser.parse_args()

    overrides = {}
    for item in args.param:
        key, _, value = item.partition("=")
        overrides[key] = json.loads(value)
    params = Params.from_config(overrides)

    tuning = aggregate([run_seed(seed, params) for seed in TUNING_SEEDS])
    if args.tuning_only:
        c = tuning["combined"]
        print(f"tuning seeds 1-5: precision {pct(c['precision'])} ({pct_range(c['precision'])}), "
              f"recall {pct(c['recall'])} ({pct_range(c['recall'])}), flagged {num(c['flagged'])}, "
              f"false alarms {num(c['false_positives'])}, misses {num(c['false_negatives'])}")
        print("false alarms by cause:", {k: round(v["mean"], 1) for k, v in tuning["false_alarms_by_cause"].items()})
        print("misses by fraud type:", {k: round(v["mean"], 1) for k, v in tuning["misses_by_fraud_type"].items()})
        return 0

    demo = run_seed(DEMO_SEED, params)
    held_out = aggregate([run_seed(seed, params) for seed in HELD_OUT_SEEDS])
    report = {
        "engine_version": __version__,
        "params": params.to_config(),
        "seeds": {"demo": DEMO_SEED, "tuning": list(TUNING_SEEDS), "held_out": list(HELD_OUT_SEEDS)},
        "demo": demo,
        "held_out": held_out,
        "tuning": tuning,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (args.out / "report.md").write_text(render_markdown(report))

    c = held_out["combined"]
    print(f"engine {__version__}: demo precision {pct(demo['combined']['precision'])}, "
          f"recall {pct(demo['combined']['recall'])}; held-out mean precision {pct(c['precision'])} "
          f"({pct_range(c['precision'])}), recall {pct(c['recall'])} ({pct_range(c['recall'])})")
    print(f"wrote {(args.out / 'report.md').relative_to(ROOT)} and report.json")

    failed = []
    if args.min_precision is not None and c["precision"]["mean"] < args.min_precision:
        failed.append(f"held-out precision {pct(c['precision'])} < {args.min_precision:.0%}")
    if args.min_recall is not None and c["recall"]["mean"] < args.min_recall:
        failed.append(f"held-out recall {pct(c['recall'])} < {args.min_recall:.0%}")
    for message in failed:
        print(f"gate failed: {message}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
