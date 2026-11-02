"""voice_vs_form: the voice note names a different water source than the form.

Two deciders, and the evidence says which one decided (decided_by):

- ai: a stored model verdict (model.Verdict, kind voice_vs_form) with
  confidence >= params.ai_min_confidence. It reads meaning, so "the pipe has
  been dry since March, we buy from the handcart man" contradicts piped_home.
- rules: otherwise, keyword matching. The keyword that appears earliest in the
  transcript decides the source (ties go to the longer keyword), so "sometimes
  the vendor, but mostly the public tap" reads as vendor.
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


def _rule(transcript: str, form_source: str) -> tuple[bool, dict]:
    heard = voice_source(transcript)
    if heard is None:
        return False, {"form_source": form_source, "voice_source": None, "matched_keyword": None}
    source, keyword, position = heard
    return source != form_source, {
        "form_source": form_source,
        "voice_source": source,
        "matched_keyword": keyword,
        "keyword_position": position,
    }


def check(target: Submission, ctx: Context) -> CheckResult:
    weight = ctx.params.weights[KEY]
    form_source = target.answers.get("water_source")
    if not target.voice_transcript or not form_source:
        return CheckResult(KEY, False, weight, {"missing": "voice_transcript or water_source"})
    rule_fired, rule = _rule(target.voice_transcript, form_source)
    ai = next((v for v in ctx.verdicts if v.kind == KEY), None)
    if ai is not None and ai.data["confidence"] >= ctx.params.ai_min_confidence:
        d = ai.data
        return CheckResult(KEY, bool(d["contradiction"]), weight, {
            "decided_by": "ai",
            "model": ai.model,
            "confidence": d["confidence"],
            "form_says": d["form_says"],
            "voice_says": d["voice_says"],
            "quote": d["quote"],
            "explanation": d["explanation"],
            "latency_ms": d.get("latency_ms"),
            "form_source": form_source,
            "rule": {**rule, "fired": rule_fired},
        })
    evidence = {"decided_by": "rules", **rule}
    if ai is not None:
        evidence["ai"] = {"model": ai.model, "confidence": ai.data["confidence"],
                          "contradiction": ai.data["contradiction"], "below": ctx.params.ai_min_confidence}
    return CheckResult(KEY, rule_fired, weight, evidence)
