"""A seeded live day (Oct 31, 2026) that continues the wave, for scripts/simulate.py.

Same contributors and the same fraud actors as build_wave(seed): E07 keeps
curbstoning at the same tea shop, E14 speeds, E22 reuses the same three
answers, E11 writes contradictions, E19 invents forms at night, the device
ring and the burst account keep going, and the usual genuine noise appears.
generate.py never inserts it: the simulator replays it through the API.
"""

from dataclasses import dataclass
from datetime import date

from . import config as cfg
from .ids import rng_for
from .wave import (
    Submission,
    Wave,
    _at,
    _seconds,
    _daytime_slots,
    assign_ids,
    build_wave,
    burst_session,
    enumerator_day,
    enumerator_profile,
    participant_household,
    participant_submission,
    plant_genuine_noise,
    ring_profile,
    ring_session,
)

LIVE_DAY = date(2026, 10, 31)
LIVE_DAY_NO = len(cfg.FIELD_DAYS) + 1
LUNCH_WIFI_SHARE = 0.5  # enumerators who also sync the morning's work over wifi at lunch


@dataclass
class LiveDay:
    seed: int
    wave: Wave
    submissions: list[Submission]  # ordered by synced_at: the order phones deliver them


def _lunch_wifi(rng, subs: list[Submission], day: date) -> None:
    """Some enumerators push the morning's interviews at a lunchtime wifi spot."""
    if rng.random() >= LUNCH_WIFI_SHARE:
        return
    lunch = _at(day, rng.uniform(13.0, 14.0))
    morning = [s for s in subs if s.captured_at < lunch and s.fraud_type != "night" and s.noise_tag != "late_sync"]
    for sub in sorted(morning, key=lambda s: s.captured_at):
        lunch += _seconds(rng.uniform(1, 5))
        sub.synced_at = lunch


def build_live_day(seed: int, wave: Wave | None = None) -> LiveDay:
    wave = wave or build_wave(seed)
    enumerators = [c for c in wave.contributors if c.kind == "enumerator"]
    participants = [c for c in wave.contributors if c.kind == "participant"]
    by_code = {c.code: c for c in wave.contributors}

    plan = rng_for(seed, "live", "noise-plan")
    clean = [e.code for e in enumerators if e.code not in cfg.FRAUD_ENUMERATORS]
    late_capture, late_sync = plan.sample(clean, 2)

    subs: list[Submission] = []
    for enum in enumerators:
        profile = enumerator_profile(rng_for(seed, "enumerator", enum.code), enum)
        rng = rng_for(seed, "live", "enumerator", enum.code)
        day_subs = enumerator_day(rng, enum, profile, LIVE_DAY, LIVE_DAY_NO, rng.choice(profile.clusters),
                                  late_capture=enum.code == late_capture, late_sync=enum.code == late_sync)
        _lunch_wifi(rng, day_subs, LIVE_DAY)
        subs.extend(day_subs)

    ring_codes = set(wave.ring_members)
    for p in participants:
        if p.code in ring_codes:
            continue
        source, bias, other = participant_household(rng_for(seed, "participant", p.code), p.area)
        rng = rng_for(seed, "live", "participant", p.code)
        if p.code == wave.burst_account:
            subs.extend(burst_session(rng, p, source, bias, LIVE_DAY))
        if rng.random() < 0.65:
            for start in _daytime_slots(rng, [LIVE_DAY], 2 if rng.random() < 0.3 else 1):
                subs.append(participant_submission(rng, p, start, source, bias, other))

    members = [by_code[code] for code in wave.ring_members]
    profile = ring_profile(rng_for(seed, "ring"), members[0].area)
    subs.extend(ring_session(rng_for(seed, "live", "ring"), members, wave.ring_device, profile, LIVE_DAY))

    plant_genuine_noise(seed, subs, stream="live-genuine-noise")
    assign_ids(seed, subs, namespace="live-submission")
    subs.sort(key=lambda s: (s.synced_at, s.captured_at, s.contributor.code))
    return LiveDay(seed, wave, subs)


def api_payload(sub: Submission) -> dict:
    """The body a phone would POST to /api/py/submissions for this submission."""
    return {
        "contributor_code": sub.contributor.code,
        "device_id": sub.device_id,
        "client_submission_id": sub.client_submission_id,
        "captured_at": sub.captured_at.isoformat(),
        "duration_sec": sub.duration_sec,
        "lat": sub.point[1],
        "lng": sub.point[0],
        "gps_accuracy_m": sub.gps_accuracy_m,
        "answers": sub.answers,
        "voice_transcript": sub.voice_transcript,
        "source": "simulator",
    }
