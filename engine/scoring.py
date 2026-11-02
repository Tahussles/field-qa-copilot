"""Runs every check and combines the results.

score = sum of weights of fired checks; flagged = score >= review_threshold.

A submission's results depend only on itself, its contributor's other
submissions and the other submissions on its device. score_incremental relies
on that: a new arrival can only change results inside that group.
"""

from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence
from zoneinfo import ZoneInfo

from . import __version__
from .checks import CHECKS
from .config import Params
from .model import CheckResult, Context, Contributor, Submission, Verdict

Verdicts = Mapping[str, Sequence[Verdict]]  # by submission id


@dataclass(frozen=True)
class ScoredSubmission:
    submission_id: str
    score: float
    flagged: bool
    results: tuple[CheckResult, ...]
    engine_version: str = __version__


def _order(sub: Submission):
    return (sub.captured_at, sub.id)


class _Index:
    def __init__(self, subs: Iterable[Submission], contributors: Mapping[str, Contributor], params: Params,
                 verdicts: Verdicts | None = None):
        self.params = params
        self.verdicts = verdicts or {}
        self.tz = ZoneInfo(params.timezone)
        self.contributors = contributors
        self.by_contributor: dict[str, list[Submission]] = defaultdict(list)
        self.by_device: dict[str, list[Submission]] = defaultdict(list)
        for sub in sorted(subs, key=_order):
            self.by_contributor[sub.contributor_id].append(sub)
            if sub.device_id:
                self.by_device[sub.device_id].append(sub)
        self._dates = {s.id: s.local_date(self.tz) for group in self.by_contributor.values() for s in group}

    def context(self, target: Submission) -> Context:
        same_contributor = tuple(s for s in self.by_contributor[target.contributor_id] if s.id != target.id)
        day = self._dates[target.id]
        same_day = tuple(s for s in same_contributor if self._dates[s.id] == day)
        same_device: tuple[Submission, ...] = ()
        accounts: tuple[tuple[Contributor, int], ...] = ()
        if target.device_id:
            on_device = self.by_device[target.device_id]
            same_device = tuple(s for s in on_device if s.id != target.id)
            counts = Counter(s.contributor_id for s in on_device)
            accounts = tuple(
                (self.contributors[cid], counts[cid])
                for cid in sorted(counts, key=lambda c: (self.contributors[c].code, c))
            )
        return Context(
            contributor=self.contributors[target.contributor_id],
            params=self.params,
            tz=self.tz,
            same_contributor=same_contributor,
            same_contributor_day=same_day,
            same_device=same_device,
            device_accounts=accounts,
            verdicts=tuple(self.verdicts.get(target.id, ())),
        )

    def score(self, target: Submission) -> ScoredSubmission:
        context = self.context(target)
        results = tuple(module.check(target, context) for module in CHECKS)
        score = round(sum(r.weight for r in results if r.fired), 4)
        return ScoredSubmission(target.id, score, score >= self.params.review_threshold, results)


def _contributor_map(contributors: Iterable[Contributor] | Mapping[str, Contributor]) -> Mapping[str, Contributor]:
    if isinstance(contributors, Mapping):
        return contributors
    return {c.id: c for c in contributors}


def score_all(submissions: Iterable[Submission], contributors: Iterable[Contributor] | Mapping[str, Contributor],
              params: Params, verdicts: Verdicts | None = None) -> list[ScoredSubmission]:
    """Score a whole batch. Output is ordered by (captured_at, id), whatever the input order."""
    subs = list(submissions)
    index = _Index(subs, _contributor_map(contributors), params, verdicts)
    return [index.score(s) for s in sorted(subs, key=_order)]


def score_incremental(new_submission: Submission, existing: Iterable[Submission],
                      contributors: Iterable[Contributor] | Mapping[str, Contributor],
                      params: Params, verdicts: Verdicts | None = None) -> list[ScoredSubmission]:
    """Score a new arrival plus every existing submission whose result it may change.

    Affected: the same contributor's submissions (any day: burst windows and
    copied-text partners cross midnight) and every submission on the same
    device (shared_device, copied-text partners). Results come back with the
    new submission first. Re-sending an id replaces the earlier copy.
    """
    everything = [s for s in existing if s.id != new_submission.id] + [new_submission]
    affected = [
        s for s in everything
        if s.contributor_id == new_submission.contributor_id
        or (new_submission.device_id and s.device_id == new_submission.device_id)
    ]
    # An affected submission's context needs its contributor's and its device's submissions.
    contributor_ids = {s.contributor_id for s in affected}
    device_ids = {s.device_id for s in affected if s.device_id}
    relevant = [s for s in everything if s.contributor_id in contributor_ids or s.device_id in device_ids]
    index = _Index(relevant, _contributor_map(contributors), params, verdicts)
    others = sorted((s for s in affected if s.id != new_submission.id), key=_order)
    return [index.score(new_submission), *(index.score(s) for s in others)]
