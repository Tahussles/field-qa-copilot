"""voice_vs_form: the voice note names a different water source than the form.

Two deciders, and the evidence says which one decided (decided_by):

- ai: a stored model verdict (model.Verdict, kind voice_vs_form) with
  confidence >= params.ai_min_confidence. It reads meaning, so "the pipe has
  been dry since March, we buy from the handcart man" contradicts piped_home.
- rules: otherwise, keyword matching on whole words (a plural counts: "pipes",
  "kiosks"; a longer word does not: "pumpkins" is not a pump, "lakeside" is not
  a lake). The source named earliest decides (ties go to the longer keyword), so
  "sometimes the vendor, but mostly the public tap" reads as vendor. "buy from"
  says vendor only when no source is named at all: "we buy from the kiosk" is
  the kiosk, which sells water by the jerrycan.

Meaning-level contradictions without a source keyword ("a tap down the road,
five shillings a jerrycan" on a piped_home form) are deliberately left to the
model verdict, not to more keywords.
"""

import re
from functools import lru_cache

from ..model import CheckResult, Context, Submission

KEY = "voice_vs_form"

# Source nouns. Compounds that name the same source are listed (pipeline); others are not words
# for a source at all (upstream, lakeside, pumpkin).
KEYWORDS = {
    "piped_home": ("our own tap", "own tap", "tap at home", "tap in the compound", "tap inside",
                   "piped", "pipe", "pipeline", "connected"),
    "public_tap": ("public tap", "communal tap", "kiosk", "water point"),
    "borehole": ("borehole", "hand pump", "pump"),
    "vendor": ("vendor", "handcart", "boda boda", "water seller"),
    "river": ("river", "stream", "lake"),
}
# How water is got, not where from: decides only when the transcript names no source.
VERB_KEYWORDS = {"vendor": ("buy from",)}


def _patterns(table: dict) -> list:
    return [(source, keyword, re.compile(r"\b" + re.escape(keyword) + r"(?:e?s)?\b"))
            for source, keywords in table.items() for keyword in keywords]


_PATTERNS = _patterns(KEYWORDS)
_VERB_PATTERNS = _patterns(VERB_KEYWORDS)


def _earliest(text: str, patterns: list) -> tuple[str, str, int] | None:
    found = []
    for source, keyword, pattern in patterns:
        match = pattern.search(text)
        if match:
            found.append((match.start(), -len(keyword), source, keyword))
    if not found:
        return None
    position, _, source, keyword = min(found)
    return source, keyword, position


@lru_cache(maxsize=16384)
def voice_source(transcript: str) -> tuple[str, str, int] | None:
    """(source, keyword, position) of the earliest source named in the transcript, or None."""
    text = transcript.lower()
    return _earliest(text, _PATTERNS) or _earliest(text, _VERB_PATTERNS)


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
