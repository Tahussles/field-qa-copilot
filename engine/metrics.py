"""Precision and recall of scored submissions against externally supplied labels.

The engine never fetches labels itself; callers that are allowed to read the
synthetic ground truth (scripts/evaluate.py, the /evaluate endpoint) pass
them in. Results are aggregates only: no submission ids.
"""

from collections import Counter
from typing import Iterable, Mapping

from .checks import CHECK_KEYS
from .scoring import ScoredSubmission

NOISE_TAGS = ("short_genuine", "straightline_genuine", "two_source_transcript",
              "compound_cluster", "late_capture", "late_sync", "untagged")
FRAUD_TYPES = ("curbstone", "speeder", "copypaste", "contradiction", "night", "multi_account", "burst")

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
    "outside_area": (),  # no synthetic fraud leaves its area: unmeasurable on these waves
}


def ratio(hits: int, total: int) -> float | None:
    return hits / total if total else None


def combined(scores: Mapping[str, float], labels: Mapping[str, Mapping], threshold: float,
             watch_threshold: float | None = None) -> dict:
    """labels: submission_id -> {"fraud_type": str | None, "noise_tag": str | None}."""
    fakes = {sid for sid, label in labels.items() if label["fraud_type"]}
    flagged = {sid for sid, score in scores.items() if score >= threshold}
    false_alarms = Counter(labels[sid]["noise_tag"] or "untagged" for sid in flagged - fakes)
    misses = Counter(labels[sid]["fraud_type"] for sid in fakes - flagged)
    out = {
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
    if watch_threshold is not None:
        out["watch"] = sum(watch_threshold <= score < threshold for score in scores.values())
    return out


def per_check(scored: Iterable[ScoredSubmission], labels: Mapping[str, Mapping]) -> dict:
    fakes = {sid for sid, label in labels.items() if label["fraud_type"]}
    fired: dict[str, set[str]] = {key: set() for key in CHECK_KEYS}
    for s in scored:
        for r in s.results:
            if r.fired:
                fired[r.key].add(s.submission_id)
    out = {}
    for key, ids in fired.items():
        targeted = {sid for sid, label in labels.items() if label["fraud_type"] in TARGETS[key]}
        out[key] = {
            "fires_on": len(ids),
            "precision": ratio(len(ids & fakes), len(ids)),
            "recall": ratio(len(ids & fakes), len(fakes)),
            "targeted_recall": ratio(len(ids & targeted), len(targeted)),
        }
    return out
