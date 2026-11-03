"""Evaluate the detection engine against synthetic ground truth, fully locally.

    uv run scripts/evaluate.py
    uv run scripts/evaluate.py --tuning-only --param 'same_spot_radius_m=30'   # explore on seeds 1-5
    uv run scripts/evaluate.py --min-precision 0.8 --min-recall 0.9          # CI gate
    uv run scripts/evaluate.py --hard                  # hard mode: rules only vs rules + AI (recorded verdicts)
    uv run scripts/evaluate.py --hard --rules-only     # hard mode, rules only

Generates waves in memory with datagen, scores them with the engine and
compares to the planted truth. No database. This is the only code that reads
the ground truth. Defaults may be tuned on TUNING_SEEDS only; HELD_OUT_SEEDS
are for reporting and the gate. Writes data/eval/report.json and report.md.

--hard scores the hard-mode waves (datagen/hard.py, seeds 201-202) twice: rules
only, and rules plus the recorded model verdicts in data/fixtures/ai_verdicts/
(made with the same prompts and validation as production by
scripts/refresh_ai_verdicts.py). It never calls a model: if a verdict is missing
or stale (another prompt version or model, or it fails today's validation) it
stops with exit 2 and says how to refresh. Writes data/eval/hard.json:
aggregates only, served read-only at /api/py/eval/hard.
"""

import argparse
import hashlib
import json
import statistics
import sys
import time
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from datagen import build_wave, db_rows  # noqa: E402
from datagen.live import LIVE_DAY, build_live_day  # noqa: E402
from engine import CHECK_KEYS, Params, Submission, Verdict, __version__, contributors_with_areas, score_all  # noqa: E402
from engine.metrics import FRAUD_TYPES, NOISE_TAGS, TARGETS, combined, per_check  # noqa: E402

DEMO_SEED = 20261031
TUNING_SEEDS = tuple(range(1, 6))
HELD_OUT_SEEDS = tuple(range(101, 111))
THRESHOLDS = tuple(1.0 + 0.5 * i for i in range(15))
COPY_METHODS = ("word_jaccard", "char_shingle")


def wave_inputs(seed: int):
    rows = db_rows(build_wave(seed))
    submissions = [Submission.from_row(r) for r in rows["submissions"]]
    contributors = contributors_with_areas(rows["contributors"], rows["areas"])
    truth = {t["submission_id"]: t for t in rows["synthetic_truth"]}
    return submissions, contributors, truth, rows["projects"][0]["timezone"]


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


def run_live_day(seed: int, params: Params) -> dict:
    """Score the wave plus the live day together, as production ends up after the simulator run."""
    wave = build_wave(seed)
    live = build_live_day(seed, wave)
    rows = db_rows(wave)
    contributors = contributors_with_areas(rows["contributors"], rows["areas"])
    params = replace(params, timezone=rows["projects"][0]["timezone"])
    wave_subs = [Submission.from_row(r) for r in rows["submissions"]]
    live_subs = [
        Submission(id=s.id, contributor_id=s.contributor.id, device_id=s.device_id, captured_at=s.captured_at,
                   synced_at=s.synced_at, duration_sec=s.duration_sec, lat=s.point[1], lng=s.point[0],
                   answers=s.answers, voice_transcript=s.voice_transcript)
        for s in live.submissions
    ]
    labels = {t["submission_id"]: t for t in rows["synthetic_truth"]}
    live_labels = {s.id: {"fraud_type": s.fraud_type, "noise_tag": s.noise_tag} for s in live.submissions}
    scored = score_all(wave_subs + live_subs, contributors, params)
    live_scored = [s for s in scored if s.submission_id in live_labels]
    scores = {s.submission_id: s.score for s in scored}
    return {
        "date": LIVE_DAY.isoformat(),
        "live": combined({k: scores[k] for k in live_labels}, live_labels, params.review_threshold,
                         params.watch_threshold),
        "live_per_check": per_check(live_scored, live_labels),
        "wave_and_live": combined(scores, {**labels, **live_labels}, params.review_threshold, params.watch_threshold),
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

    live = report.get("live_day")
    if live:
        lines += ["", f"## Live day ({live['date']}, replayed through the API by scripts/simulate.py)", "",
                  "Scored together with the demo wave, which is what production holds after a full simulator run.", "",
                  "| | precision | recall | flagged | watch | false alarms | misses | fabricated | submissions |",
                  "|---|---|---|---|---|---|---|---|---|"]
        for label, c in (("live day rows", live["live"]), ("wave + live day", live["wave_and_live"])):
            lines.append(f"| {label} | {pct(c['precision'])} | {pct(c['recall'])} | {c['flagged']} | {c['watch']} | "
                         f"{c['false_positives']} | {c['false_negatives']} | {c['fabricated']} | {c['submissions']} |")
        alarms = {k: v for k, v in live["live"]["false_alarms_by_cause"].items() if v}
        misses = {k: v for k, v in live["live"]["misses_by_fraud_type"].items() if v}
        lines += ["", f"Live-day false alarms by cause: {alarms or 'none'}. Misses by fraud type: {misses or 'none'}."]

    lines += ["", f"Scoring time: {demo['score_ms']:.0f} ms for the demo wave "
              f"({demo['combined']['submissions']} submissions).", ""]
    return "\n".join(lines)


# Hard mode: rules only vs rules + AI, from recorded verdicts ------------------------------------

# The model verdicts for the hard-mode waves, committed so CI (and anyone) can score rules + AI without
# keys or spend. One file per seed. Each entry is keyed by kind, input hash, prompt version and model id;
# scripts/refresh_ai_verdicts.py makes the real calls (cost guard) and rewrites them.
RECORDED = ROOT / "data" / "fixtures" / "ai_verdicts"
REFRESH = "uv run scripts/refresh_ai_verdicts.py --estimate   # then without --estimate"


def input_hash(kind: str, args) -> str:
    return hashlib.sha256(json.dumps([kind, *args]).encode()).hexdigest()[:16]


def hard_calls(rows: dict, params: Params) -> list[dict]:
    """Every model call production would make for this wave: meaning checks and paraphrase pairs."""
    from api._lib.ai import JUDGE_MODEL, PROMPT_VERSION
    from api._lib.jobs import PARAPHRASE_PAIRS_PER_ARRIVAL, paraphrase_candidates

    def call(kind, args, **extra):
        digest = input_hash(kind, args)
        return {"kind": kind, "args": args, "input_hash": digest,
                "key": f"{kind}:{digest}:{PROMPT_VERSION}:{JUDGE_MODEL}", **extra}

    subs = sorted(rows["submissions"], key=lambda r: (r["captured_at"], r["id"]))
    calls = []
    for i, row in enumerate(subs):
        answers = row["answers"]
        if row.get("voice_transcript") and answers.get("water_source"):
            args = (answers["water_source"], answers.get("open_text") or "", row["voice_transcript"])
            calls.append(call("consistency", args, submission_id=row["id"]))
        earlier = [o for o in subs[:i] if o["contributor_id"] == row["contributor_id"]
                   or (row.get("device_id") and o.get("device_id") == row["device_id"])]
        for pair in paraphrase_candidates(row, earlier, params, PARAPHRASE_PAIRS_PER_ARRIVAL):
            other = next(o for o in earlier if o["id"] == pair["other_id"])
            args = (other["answers"]["open_text"].strip(), row["answers"]["open_text"].strip())
            calls.append(call("paraphrase", args, submission_id=row["id"], other_id=other["id"],
                              similarity=pair["similarity"]))
    return calls


def recorded_path(seed: int) -> Path:
    return RECORDED / f"hard-{seed}.json"


def load_recorded(seed: int) -> dict[str, dict]:
    path = recorded_path(seed)
    return json.loads(path.read_text())["entries"] if path.exists() else {}


def write_recorded(seed: int, entries: dict[str, dict]) -> None:
    """One entry per line, sorted, so a refresh shows up as a readable diff."""
    from api._lib.ai import JUDGE_MODEL, PROMPT_VERSION

    RECORDED.mkdir(parents=True, exist_ok=True)
    head = {"about": f"Recorded model verdicts for hard-mode seed {seed} (scripts/refresh_ai_verdicts.py).",
            "seed": seed, "prompt": PROMPT_VERSION, "model": JUDGE_MODEL}
    lines = [f"{json.dumps(k)}: {json.dumps(entries[k], sort_keys=True)}" for k in sorted(entries)]
    body = json.dumps(head, indent=1)[:-2] + ',\n "entries": {\n' + ",\n".join(lines) + "\n }\n}\n"
    recorded_path(seed).write_text(body)


def usable(call: dict, entry: dict) -> bool:
    """A recorded verdict must still pass today's validation (the same models and quote check as production)."""
    from api._lib.ai import ConsistencyVerdict, ParaphraseVerdict, check_consistency

    if "error" in entry:
        return True  # a recorded failure: the rule stands, as in production
    try:
        if call["kind"] == "consistency":
            return check_consistency(ConsistencyVerdict.model_validate(entry["verdict"]), call["args"][2]) is None
        ParaphraseVerdict.model_validate(entry["verdict"])
        return True
    except ValueError:
        return False


def recorded_status(calls: list[dict], entries: dict[str, dict]) -> dict:
    """missing: never recorded; stale: recorded for another prompt version or model, or fails validation now."""
    by_input = {}
    for key, entry in entries.items():
        by_input.setdefault(f"{entry['kind']}:{entry['input_hash']}", []).append(entry)
    found, missing, stale = {}, [], []
    for c in calls:
        entry = entries.get(c["key"])
        if entry is not None and usable(c, entry):
            found[c["key"]] = entry
        elif entry is not None or by_input.get(f"{c['kind']}:{c['input_hash']}"):
            stale.append(c)
        else:
            missing.append(c)
    return {"found": found, "missing": missing, "stale": stale}


def hard_verdicts(calls: list[dict], found: dict) -> dict[str, list[Verdict]]:
    from api._lib.ai import ConsistencyVerdict, ParaphraseVerdict

    out: dict[str, list[Verdict]] = {}
    for call in calls:
        hit = found.get(call["key"])
        if not hit or "verdict" not in hit:
            continue
        model = ConsistencyVerdict if call["kind"] == "consistency" else ParaphraseVerdict
        data = {**model.model_validate(hit["verdict"]).model_dump(), "latency_ms": hit["latency_ms"]}
        if call["kind"] == "consistency":
            out.setdefault(call["submission_id"], []).append(Verdict("voice_vs_form", hit["model"], data))
        else:
            data["similarity"] = call["similarity"]
            out.setdefault(call["submission_id"], []).append(Verdict("paraphrase", hit["model"], data, call["other_id"]))
            out.setdefault(call["other_id"], []).append(Verdict("paraphrase", hit["model"], data, call["submission_id"]))
    return out


def hard_waves(params: Params) -> dict[int, tuple[dict, list[dict]]]:
    from datagen.hard import HARD_SEEDS, build_hard_wave

    waves = {}
    for seed in HARD_SEEDS:
        rows = db_rows(build_hard_wave(seed))
        waves[seed] = (rows, hard_calls(rows, replace(params, timezone=rows["projects"][0]["timezone"])))
    return waves


def run_hard(args, params: Params) -> int:
    from api._lib.ai import JUDGE_MODEL, PROMPT_VERSION
    from datagen.hard import HARD_HELD_OUT_SEEDS, HARD_TUNING_SEEDS

    waves = hard_waves(params)
    found: dict[str, dict] = {}
    problems = []
    for seed, (_, calls) in waves.items():
        status = recorded_status(calls, load_recorded(seed))
        found.update(status["found"])
        if status["missing"] or status["stale"]:
            problems.append(f"  {recorded_path(seed).relative_to(ROOT)}: {len(status['missing'])} missing, "
                            f"{len(status['stale'])} stale (of {len(calls)} calls)")
    all_calls = {c["key"]: c for _, calls in waves.values() for c in calls}
    kinds = {k: sum(c["kind"] == k for c in all_calls.values()) for k in ("consistency", "paraphrase")}
    print(f"hard mode: {len(all_calls)} model calls ({kinds}), prompt {PROMPT_VERSION}, model {JUDGE_MODEL}; "
          f"{len(found)} recorded")
    if problems and not args.rules_only:
        print("recorded verdicts do not cover this code (the prompt, the model or the inputs changed):\n"
              + "\n".join(problems) + f"\nrefresh them with real calls: {REFRESH}", file=sys.stderr)
        return 2

    # The engine's current params ("rules_ai"), the model-only copy at its old full weight ("rules_ai_before",
    # engine 0.3.0), and on the tuning seeds a sweep of that weight.
    # And both sides with clock_skew weighing nothing: what the night forger's clock trick gets past without it.
    no_clock = {"weights": {**params.weights, "clock_skew": 0.0}}
    variants = {"rules": (False, {}), "rules_ai": (True, {}),
                "rules_ai_before": (True, {"ai_paraphrase_weight": params.weights["copied_text"]}),
                "rules_no_clock": (False, no_clock), "rules_ai_no_clock": (True, no_clock)}
    sweep_weights = (1.0, 1.5, 2.0, 3.0)
    per_seed = {}
    for seed, (rows, calls) in waves.items():
        subs = [Submission.from_row(r) for r in rows["submissions"]]
        contributors = contributors_with_areas(rows["contributors"], rows["areas"])
        truth = {t["submission_id"]: t for t in rows["synthetic_truth"]}
        seed_params = replace(params, timezone=rows["projects"][0]["timezone"])
        verdicts = {} if args.rules_only else hard_verdicts(calls, found)
        result = {"seed": seed}
        for label, (with_ai, overrides) in variants.items():
            scored = score_all(subs, contributors, replace(seed_params, **overrides), verdicts if with_ai else None)
            result[label] = {
                "combined": combined({s.submission_id: s.score for s in scored}, truth, seed_params.review_threshold),
                "per_check": per_check(scored, truth),
                "decided_by_ai": sum(
                    1 for s in scored for r in s.results
                    if r.fired and r.evidence.get("decided_by") in ("ai", "ai_paraphrase")),
            }
        if seed in HARD_TUNING_SEEDS:
            result["sweep"] = {w: combined({s.submission_id: s.score for s in score_all(
                subs, contributors, replace(seed_params, ai_paraphrase_weight=w), verdicts)}, truth,
                seed_params.review_threshold) for w in sweep_weights}
        per_seed[seed] = result

    def mean(path, seeds):
        values = [path(per_seed[s]) for s in seeds]
        values = [v for v in values if v is not None]
        return round(statistics.mean(values), 4) if values else None

    def side(label, seeds):
        c = lambda r: r[label]["combined"]  # noqa: E731
        return {
            "combined": {k: mean(lambda r, k=k: c(r)[k], seeds) for k in
                         ("submissions", "fabricated", "flagged", "precision", "recall", "false_positives",
                          "false_negatives")},
            "per_check": {key: {m: mean(lambda r, key=key, m=m: r[label]["per_check"][key][m], seeds)
                                for m in ("fires_on", "precision", "recall", "targeted_recall")} for key in CHECK_KEYS},
            "misses_by_fraud_type": {ft: mean(lambda r, ft=ft: c(r)["misses_by_fraud_type"][ft], seeds)
                                     for ft in FRAUD_TYPES},
            "decided_by_ai": mean(lambda r: r[label]["decided_by_ai"], seeds),
        }

    held, tuning = HARD_HELD_OUT_SEEDS, HARD_TUNING_SEEDS
    rules, rules_ai = side("rules", held), side("rules_ai", held)
    keys = ("precision", "recall", "flagged", "false_positives")
    sweep = [{"ai_paraphrase_weight": w, **{k: mean(lambda r, w=w, k=k: r["sweep"][w][k], tuning) for k in keys}}
             for w in sweep_weights]
    calls_made = [found[c["key"]] for c in all_calls.values() if c["key"] in found]
    latencies = [e["latency_ms"] for e in calls_made if e.get("latency_ms") is not None]
    planted = {}
    for seed in held:
        for t in waves[seed][0]["synthetic_truth"]:
            if t["fraud_type"]:
                planted[t["fraud_type"]] = planted.get(t["fraud_type"], 0) + 1 / len(held)
    gaps = []
    for ft in FRAUD_TYPES:
        missed = rules_ai["misses_by_fraud_type"][ft] or 0
        if planted.get(ft) and missed / planted[ft] >= 0.5:
            gaps.append({"fraud_type": ft, "planted": round(planted[ft], 1), "missed": missed,
                         "missed_by_rules": rules["misses_by_fraud_type"][ft]})
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "engine_version": __version__,
        "seeds": list(held),  # what the panel's numbers are averaged over
        "tuning_seeds": list(tuning),
        "model": JUDGE_MODEL,
        "rules_only_run": bool(args.rules_only),
        "prompt": PROMPT_VERSION,
        "calls": {"total": len(all_calls), **kinds,
                  "verdicts": sum("verdict" in e for e in calls_made), "failed": sum("error" in e for e in calls_made),
                  "median_latency_ms": statistics.median(latencies) if latencies else None},
        "cost_usd": {"all_cached_calls": round(sum(e.get("cost_usd", 0) for e in calls_made), 4)},
        "planted_per_wave": {k: round(v, 1) for k, v in planted.items()},
        "rules": rules,
        "rules_ai": rules_ai,
        "paraphrase_weight": {
            "tuning_sweep": sweep,
            "held_out_before": side("rules_ai_before", held)["combined"],
            "held_out_after": rules_ai["combined"],
            "tuning_before": side("rules_ai_before", tuning)["combined"],
            "tuning_after": side("rules_ai", tuning)["combined"],
        },
        "gaps": gaps,
        "clock_skew": {
            "about": "the night forger sets the phone clock back 3 h; every other phone drifts at most 2 minutes",
            "without": {"rules": side("rules_no_clock", held)["combined"],
                        "rules_ai": side("rules_ai_no_clock", held)["combined"],
                        "night_missed": side("rules_ai_no_clock", held)["misses_by_fraud_type"]["night"]},
            "with": {"rules": rules["combined"], "rules_ai": rules_ai["combined"],
                     "night_missed": rules_ai["misses_by_fraud_type"]["night"]},
        },
        "unmeasured": {"outside_area": "every synthetic point is inside its area, so it never fires here"},
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "hard.json").write_text(json.dumps(report, indent=2) + "\n")
    for label, data in (("rules only", rules), ("rules + AI", rules_ai)):
        c = data["combined"]
        print(f"held-out {label:<11} precision {pct(c['precision'])}  recall {pct(c['recall'])}  flagged {c['flagged']}  "
              f"misses {({k: v for k, v in data['misses_by_fraud_type'].items() if v})}")
    for name, values in report["paraphrase_weight"].items():
        print(f"paraphrase weight {name}: {values}")
    print(f"from recorded verdicts (no model call); wrote {args.out / 'hard.json'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--param", action="append", default=[], metavar="KEY=JSON",
                        help="override a default, e.g. same_spot_radius_m=30 or weights='{\"burst\": 3}'")
    parser.add_argument("--tuning-only", action="store_true", help="only run tuning seeds 1-5 (for exploring changes)")
    parser.add_argument("--min-precision", type=float, help="exit 1 if held-out mean precision is below this")
    parser.add_argument("--min-recall", type=float, help="exit 1 if held-out mean recall is below this")
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "eval")
    parser.add_argument("--hard", action="store_true",
                        help="hard mode: rules only vs rules + AI from recorded verdicts (seeds 201-202)")
    parser.add_argument("--rules-only", action="store_true", help="with --hard: ignore the recorded verdicts")
    args = parser.parse_args()

    overrides = {}
    for item in args.param:
        key, _, value = item.partition("=")
        overrides[key] = json.loads(value)
    params = Params.from_config(overrides)
    if args.hard:
        return run_hard(args, params)

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
        "live_day": run_live_day(DEMO_SEED, params),
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (args.out / "report.md").write_text(render_markdown(report))

    c = held_out["combined"]
    print(f"engine {__version__}: demo precision {pct(demo['combined']['precision'])}, "
          f"recall {pct(demo['combined']['recall'])}; held-out mean precision {pct(c['precision'])} "
          f"({pct_range(c['precision'])}), recall {pct(c['recall'])} ({pct_range(c['recall'])})")
    print(f"wrote {args.out / 'report.md'} and report.json")

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
