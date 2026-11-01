"""Deterministic ids and random streams derived from the seed."""

import uuid
from random import Random

_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://github.com/Tahussles/field-qa-copilot/datagen")


def _key(seed: int, parts: tuple) -> str:
    return "/".join([str(seed), *map(str, parts)])


def make_uuid(seed: int, *parts) -> str:
    return str(uuid.uuid5(_NAMESPACE, _key(seed, parts)))


def device_id(seed: int, owner: str) -> str:
    """16 hex characters, like an Android device id."""
    return uuid.uuid5(_NAMESPACE, _key(seed, ("device", owner))).hex[:16]


def rng_for(seed: int, *parts) -> Random:
    """An independent random stream for one purpose, so parts of the wave don't share draws."""
    return Random(_key(seed, parts))
