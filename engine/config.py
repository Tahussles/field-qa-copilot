"""Check parameters: engine defaults, overridable per project through check_config.params."""

from dataclasses import asdict, dataclass, field
from datetime import time
from typing import Any, Mapping

KINDS = ("enumerator", "participant")
COPY_METHODS = ("word_jaccard", "char_shingle")

DEFAULT_WEIGHTS = {
    "too_fast": 2.0,
    # Below the review threshold on purpose: neighbouring households and
    # compounds put genuine interviews close together, so same_spot only flags
    # with corroboration (burst, too_fast, off_hours...). Spec value was 3.0;
    # on tuning seeds 1-5 any weight under 2 gives precision 87.7% vs 58.4%,
    # recall 99.5% vs 100%.
    "same_spot": 1.5,
    "copied_text": 3.0,
    "straight_lining": 1.5,
    "voice_vs_form": 2.0,
    "off_hours": 1.0,
    "shared_device": 3.0,
    "burst": 2.5,
    # Far outside (beyond outside_area_far_m); closer misses weigh outside_area_near_weight.
    # The synthetic waves keep every point inside its area, so no seed measures it.
    "outside_area": 2.0,
    # Phone clock off by more than clock_skew_max_minutes. Corroboration only: an honest phone with a
    # wrong clock is not fraud, but a night actor setting the clock back is (hard mode, data/eval/hard.json).
    # The synthetic waves carry no phone clock, so no seed measures it.
    "clock_skew": 1.5,
}


@dataclass(frozen=True)
class Params:
    # score >= review_threshold goes to the review queue; watch_threshold <= score
    # < review_threshold is the "watch" band (counted and filterable, never queued).
    review_threshold: float = 2.0
    watch_threshold: float = 1.0
    weights: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_WEIGHTS))
    # too_fast: minimum plausible duration per contributor kind.
    too_fast_min_minutes: dict[str, float] = field(
        default_factory=lambda: {"enumerator": 12, "participant": 3})
    # same_spot: enumerators only.
    same_spot_radius_m: float = 50.0
    same_spot_min_neighbours: int = 2
    # copied_text: word_jaccard compares content words, char_shingle compares 3-character shingles.
    copy_method: str = "word_jaccard"
    copy_similarity: float = 0.8
    # off_hours: local wall-clock window, wrapping past midnight.
    off_hours_start: str = "21:00"
    off_hours_end: str = "06:00"
    burst_window_minutes: float = 60
    burst_min_count: dict[str, int] = field(default_factory=lambda: {"enumerator": 4, "participant": 5})
    shared_device_min_accounts: int = 2
    # voice_vs_form: a stored AI verdict decides only at or above this confidence;
    # below it (or with no verdict) the keyword rule decides.
    ai_min_confidence: float = 0.7
    # copied_text decided only by a model's "reworded copy" verdict weighs this
    # (corroboration only: below review_threshold on its own), not the 3.0 a
    # rule-found copy weighs. Hard-mode tuning seeds 211-212 cannot tell weights
    # apart: precision 91.2%, recall 86.3% at 1.0, 1.5, 2.0 and 3.0 alike (no
    # model-only copy changed a band there), so the value is the policy, any
    # weight below review_threshold. data/eval/hard.json has the sweep.
    ai_paraphrase_weight: float = 1.5
    # outside_area fires only beyond max(gps_accuracy_m, outside_area_min_tolerance_m) from the boundary.
    # Tuning seeds 1-5 cannot show it directly: every genuine point is >= 50 m inside its area, and
    # 1.58M simulated GPS errors (68% within the reported accuracy) never left it. Worst case instead:
    # all 7,908 genuine accuracies (median 15.2 m, p95 25 m, max 150 m) placed exactly on the boundary.
    # No tolerance fires 50% of those fixes; max(accuracy, 15 m) fires 4.3%, overshooting by median 24 m,
    # p99 181 m, max 384 m. So a miss within outside_area_far_m (1 km, 2.6x the worst) can be GPS error
    # at a boundary household and only corroborates (1.5); beyond it, the full weight (2.0).
    outside_area_min_tolerance_m: float = 15.0
    outside_area_far_m: float = 1000.0
    outside_area_near_weight: float = 1.5
    # straight_lining also fires on a strict two-value zig-zag (5, 4, 5, 4, ...).
    straight_lining_alternation: bool = True
    # clock_skew: |phone clock - server clock| at sync, or a capture time after the server received it.
    clock_skew_max_minutes: float = 5.0
    # Comes from projects.timezone, not from check_config.
    timezone: str = "Africa/Nairobi"

    @classmethod
    def from_config(cls, overrides: Mapping[str, Any] | None = None, **extra: Any) -> "Params":
        """Merge check_config.params (and keyword overrides) over the defaults.

        Nested dicts merge key by key, so {"weights": {"burst": 3}} changes one weight.
        Unknown keys raise, so a typo never silently falls back to a default.
        """
        merged = asdict(cls())
        for key, value in {**(overrides or {}), **extra}.items():
            if key not in merged:
                raise ValueError(f"unknown check param: {key}")
            if isinstance(merged[key], dict):
                unknown = set(value) - set(merged[key])
                if unknown:
                    raise ValueError(f"unknown keys in {key}: {sorted(unknown)}")
                merged[key] = {**merged[key], **value}
            else:
                merged[key] = value
        params = cls(**merged)
        params.validate()
        return params

    def validate(self) -> None:
        if self.copy_method not in COPY_METHODS:
            raise ValueError(f"copy_method must be one of {COPY_METHODS}")
        if set(self.too_fast_min_minutes) != set(KINDS) or set(self.burst_min_count) != set(KINDS):
            raise ValueError(f"per-kind params need exactly {KINDS}")
        time.fromisoformat(self.off_hours_start)
        time.fromisoformat(self.off_hours_end)

    def band(self, score: float) -> str:
        if score >= self.review_threshold:
            return "flagged"
        if score >= self.watch_threshold:
            return "watch"
        return "clear"

    def to_dict(self) -> dict[str, Any]:
        """Everything used for a scoring run; stored on scores.config."""
        return asdict(self)

    def to_config(self) -> dict[str, Any]:
        """What belongs in check_config.params (timezone lives on the project)."""
        config = asdict(self)
        del config["timezone"]
        return config
