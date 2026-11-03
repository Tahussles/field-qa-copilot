"""Deterministic, explainable fabrication checks for field data submissions.

Pure Python, standard library only, no I/O and no AI. Model judgments arrive
as stored verdicts (model.Verdict), inputs like any other. Every result carries
the engine version so stored results can be traced to the code that made them.
"""

# 0.3.0: voice_vs_form and copied_text read stored AI verdicts.
# 0.4.0: outside_area; a copy found only by the model weighs ai_paraphrase_weight.
# 0.5.0: clock_skew; outside_area allows GPS error and weighs less near the boundary; straight_lining
#        catches a two-value zig-zag; voice keywords match whole words and "buy from" only as a fallback.
__version__ = "0.5.0"

from .checks import CHECK_KEYS  # noqa: E402
from .config import Params  # noqa: E402
from .model import Area, CheckResult, Contributor, Submission, Verdict, contributors_with_areas  # noqa: E402
from .scoring import ScoredSubmission, score_all, score_incremental  # noqa: E402

__all__ = [
    "Area",
    "CHECK_KEYS",
    "CheckResult",
    "Contributor",
    "Params",
    "ScoredSubmission",
    "Submission",
    "Verdict",
    "contributors_with_areas",
    "score_all",
    "score_incremental",
]
