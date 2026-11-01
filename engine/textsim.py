"""Text similarity for copied_text: content-word Jaccard and character 3-gram shingles."""

import re
from functools import lru_cache

STOPWORDS = frozenset("""
a about above after again all also am an and any are as at be because been before being
below between both but by can could did do does doing down during each even every few for
from further had has have having he her here hers him his how i if in into is it its itself
just me more most much my myself no nor not now of off on once only or other our ours out
over own same she should so some such than that the their theirs them then there these they
this those through to too under until up us very was we were what when where which while who
whom why will with would you your yours
""".split())

_WORD = re.compile(r"[a-z0-9']+")


@lru_cache(maxsize=16384)
def content_words(text: str) -> frozenset[str]:
    return frozenset(w for w in _WORD.findall(text.lower()) if w not in STOPWORDS)


@lru_cache(maxsize=16384)
def char_shingles(text: str, size: int = 3) -> frozenset[str]:
    normalized = " ".join(_WORD.findall(text.lower()))
    return frozenset(normalized[i:i + size] for i in range(len(normalized) - size + 1))


def jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a and not b:
        return 0.0
    shared = len(a & b)
    return shared / (len(a) + len(b) - shared)


# Pair results are cached in a canonical order: every pair is compared from
# both sides within a run, and the same texts recur across /evaluate calls.
@lru_cache(maxsize=131072)
def _word_pair(a: str, b: str) -> float:
    return jaccard(content_words(a), content_words(b))


@lru_cache(maxsize=131072)
def _shingle_pair(a: str, b: str) -> float:
    return jaccard(char_shingles(a), char_shingles(b))


def word_jaccard(a: str, b: str) -> float:
    return _word_pair(a, b) if a <= b else _word_pair(b, a)


def shingle_jaccard(a: str, b: str) -> float:
    return _shingle_pair(a, b) if a <= b else _shingle_pair(b, a)


SIMILARITY = {"word_jaccard": word_jaccard, "char_shingle": shingle_jaccard}
