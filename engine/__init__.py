"""Deterministic, explainable fabrication checks for field data submissions.

Pure Python, standard library only, no I/O and no AI. Model judgments arrive
as stored verdicts (model.Verdict), inputs like any other. Every result carries
the engine version so stored results can be traced to the code that made them.
"""

# 0.3.0: voice_vs_form and copied_text read stored AI verdicts.
__version__ = "0.3.0"

from .checks import CHECK_KEYS  # noqa: E402
from .config import Params  # noqa: E402
from .model import CheckResult, Contributor, Submission, Verdict  # noqa: E402
from .scoring import ScoredSubmission, score_all, score_incremental  # noqa: E402

__all__ = [
    "CHECK_KEYS",
    "CheckResult",
    "Contributor",
    "Params",
    "ScoredSubmission",
    "Submission",
    "Verdict",
    "score_all",
    "score_incremental",
]
