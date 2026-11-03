"""Hard mode: the same wave with fraud written by someone trying not to get caught.

Only for evaluation (scripts/evaluate.py --hard). Tune on HARD_TUNING_SEEDS,
report on HARD_HELD_OUT_SEEDS (as with seeds 1-5 and 101-110 in normal mode). Never the
demo wave: build_wave(seed) is untouched, and hard mode rewrites three actors'
planted fraud after the fact, with its own random streams:

- E22 rewords instead of copying: 2 to 4 word swaps (synonyms) and the two
  sentences reordered, so the answers are no longer near-duplicates by words.
- E11's contradictions get subtle: the voice note mentions the home pipe first
  ("the pipe at home has been dry since March, so we buy from the handcart
  man") while the form says piped_home. The keyword rule hears "pipe" and agrees.
- E07 becomes a careful curbstoner: the tea-shop forms are walked 60 to 120 m
  apart, with 20+ minute gaps and believable durations.

The labels (fraud_type) are unchanged, so precision and recall stay comparable.
"""

import math
from datetime import timedelta
from random import Random

from . import config as cfg
from . import geo
from .ids import rng_for
from .text import SWAPS
from .wave import Submission, Wave, build_wave

HARD_TUNING_SEEDS = (211, 212)
HARD_HELD_OUT_SEEDS = (201, 202)
HARD_SEEDS = HARD_TUNING_SEEDS + HARD_HELD_OUT_SEEDS

# More one-word synonyms on top of the near-copy swaps.
REWORDS = {
    **SWAPS,
    "queue": "line",
    "jerrican": "container",
    "jerricans": "containers",
    "shillings": "bob",
    "far": "distant",
    "carry": "haul",
    "fetch": "collect",
    "late": "behind",
    "tired": "exhausted",
    "afford": "manage",
    "expensive": "costly",
    "sometimes": "occasionally",
    "always": "constantly",
    "hours": "hrs",
    "minutes": "mins",
}

SUBTLE = {
    "vendor": (
        "The pipe at home has been dry since {month}, so we buy from the handcart man.",
        "We are connected, but nothing has come through the tap since {month}; now we pay the water sellers.",
        "Our own tap is there but it is broken, so we buy jerricans from the vendor every morning.",
    ),
    "river": (
        "The pipe at home has been dry since {month}, so the children carry water up from the river.",
        "We have a tap in the compound, but it stopped in {month}, so we go down to the river now.",
        "The company disconnected our pipe in {month}; we fetch from the river and boil it.",
    ),
}
MONTHS = ("March", "April", "May", "June", "July", "August")


def reworded(rng: Random, answer: str) -> str:
    """2 to 4 synonym swaps, and the first two sentences swapped half the time."""
    sentences = [s for s in answer.split(". ") if s]
    if len(sentences) >= 2 and rng.random() < 0.5:
        sentences[0], sentences[1] = sentences[1], sentences[0]
    text = ". ".join(s.rstrip(".") for s in sentences) + "."
    words = text.split(" ")
    options = [i for i, w in enumerate(words) if w.rstrip(".,;").lower() in REWORDS]
    for i in rng.sample(options, min(len(options), rng.randint(2, 4))):
        core = words[i].rstrip(".,;")
        new = REWORDS[core.lower()]
        words[i] = (new.capitalize() if core[0].isupper() else new) + words[i][len(core):]
    return " ".join(words)


def _voice_source(transcript: str) -> str:
    lowered = transcript.lower()
    return "river" if ("river" in lowered or "stream" in lowered or "lake" in lowered) else "vendor"


def _walk(rng: Random, ring, start: geo.Point, metres: float) -> geo.Point:
    """A point `metres` from start in a random direction, kept inside the area."""
    for _ in range(50):
        angle = rng.uniform(0, 2 * math.pi)
        dlat = metres * math.cos(angle) / 111_320
        dlng = metres * math.sin(angle) / (111_320 * math.cos(math.radians(start[1])))
        point = (start[0] + dlng, start[1] + dlat)
        if geo.contains(ring, point):
            return point
    return start


def _careful_curbstoner(seed: int, subs: list[Submission]) -> None:
    by_day: dict = {}
    for sub in subs:
        if sub.fraud_type == "curbstone":
            by_day.setdefault(sub.captured_at.astimezone(cfg.EAT).date(), []).append(sub)
    for day, fakes in sorted(by_day.items()):
        rng = rng_for(seed, "hard", "curbstone", day.isoformat())
        fakes.sort(key=lambda s: s.captured_at)
        point = fakes[0].point
        when = fakes[0].captured_at - timedelta(seconds=fakes[0].duration_sec)
        for i, sub in enumerate(fakes):
            if i:
                point = _walk(rng, sub.contributor.area.ring, point, rng.uniform(60, 120))
                when += timedelta(minutes=rng.uniform(20, 35))
            sub.duration_sec = round(rng.uniform(14, 24) * 60)
            sub.point = (round(point[0], 6), round(point[1], 6))
            sub.captured_at = when + timedelta(seconds=sub.duration_sec)
            sub.synced_at = max(sub.synced_at, sub.captured_at + timedelta(minutes=rng.uniform(2, 20)))
            when = sub.captured_at


def build_hard_wave(seed: int) -> Wave:
    if seed == 20261031:
        raise ValueError("hard mode never uses the demo seed")
    wave = build_wave(seed)
    rng = rng_for(seed, "hard", "text")
    for sub in wave.submissions:
        if sub.fraud_type == "copypaste":
            sub.answers = {**sub.answers, "open_text": reworded(rng, sub.answers["open_text"])}
        elif sub.fraud_type == "contradiction":
            template = rng.choice(SUBTLE[_voice_source(sub.voice_transcript)])
            sub.voice_transcript = template.format(month=rng.choice(MONTHS))
    _careful_curbstoner(seed, wave.submissions)
    wave.submissions.sort(key=lambda s: (s.captured_at, s.contributor.code))
    return wave
