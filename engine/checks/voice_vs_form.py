"""voice_vs_form: the voice note names a different water source than the form.

Deliberately simple keyword matching: the keyword that appears earliest in the
transcript decides the source (ties go to the longer keyword). A transcript
like "sometimes the vendor, but mostly the public tap" therefore reads as
vendor. A later round replaces this with a model that should do better.
"""

import re
from functools import lru_cache

from ..model import CheckResult, Context, Submission

KEY = "voice_vs_form"

KEYWORDS = {
    "piped_home": ("our own tap", "own tap", "tap at home", "tap in the compound", "tap inside",
                   "piped", "pipe", "connected"),
    "public_tap": ("public tap", "communal tap", "kiosk", "water point"),
    "borehole": ("borehole", "hand pump", "pump"),
    "vendor": ("vendor", "handcart", "buy from", "boda boda", "water seller"),
    "river": ("river", "stream", "lake"),
}
_PATTERNS = [
    (source, keyword, re.compile(r"\b" + re.escape(keyword)))
    for source, keywords in KEYWORDS.items()
    for keyword in keywords
]


@lru_cache(maxsize=16384)
def voice_source(transcript: str) -> tuple[str, str, int] | None:
    """(source, keyword, position) of the earliest keyword in the transcript, or None."""
    text = transcript.lower()
    found = []
    for source, keyword, pattern in _PATTERNS:
        match = pattern.search(text)
        if match:
            found.append((match.start(), -len(keyword), source, keyword))
    if not found:
        return None
    position, _, source, keyword = min(found)
    return source, keyword, position


def check(target: Submission, ctx: Context) -> CheckResult:
    weight = ctx.params.weights[KEY]
    form_source = target.answers.get("water_source")
    if not target.voice_transcript or not form_source:
        return CheckResult(KEY, False, weight, {"missing": "voice_transcript or water_source"})
    heard = voice_source(target.voice_transcript)
    if heard is None:
        return CheckResult(KEY, False, weight, {
            "form_source": form_source, "voice_source": None, "matched_keyword": None,
        })
    source, keyword, position = heard
    return CheckResult(KEY, source != form_source, weight, {
        "form_source": form_source,
        "voice_source": source,
        "matched_keyword": keyword,
        "keyword_position": position,
    })
