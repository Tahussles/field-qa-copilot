"""Builds one seeded survey wave: project, areas, contributors and submissions.

Each part of the wave draws from its own Random seeded with (seed, purpose), so
the same seed always gives the same rows, ids included, and changing one part
does not reshuffle the rest. Times are planned in EAT and stored in UTC.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from random import Random

from . import config as cfg
from . import geo, text
from .ids import device_id, make_uuid, rng_for

# Satisfaction model: item baselines plus a per-respondent bias that depends
# partly on the household's water source.
ITEM_MEANS = (3.2, 2.9, 2.6, 3.3, 2.7, 3.4, 3.0, 3.0)
SOURCE_EFFECT = {"piped_home": 0.7, "public_tap": 0.0, "borehole": -0.1, "vendor": -0.4, "river": -0.9}

WALK_M_PER_MIN = 70
WORKDAY_END_HOUR = 19.5

# Genuine behaviour that looks suspicious. These rows stay is_fabricated = false.
SHORT_GENUINE_RATE = 0.01
STRAIGHTLINE_GENUINE_RATE = 0.005
TWO_SOURCE_RATE = 0.005
COMPOUND_DAY_RATE = 0.04
LATE_CAPTURE_DAYS = 4
LATE_SYNC_DAYS = 3

PROJECT_CREATED = datetime(2026, 10, 18, 6, 0, tzinfo=timezone.utc)
ENUMERATORS_REGISTERED = datetime(2026, 10, 22, 6, 0, tzinfo=timezone.utc)
PARTICIPANTS_REGISTERED = datetime(2026, 10, 23, 9, 0, tzinfo=timezone.utc)


@dataclass
class Area:
    id: str
    name: str
    ring: list[list[float]]
    source_weights: tuple[float, ...]
    landmarks: tuple[str, ...]


@dataclass
class Contributor:
    id: str
    code: str
    display_name: str
    kind: str
    area: Area
    device_id: str
    home: geo.Point
    created_at: datetime


@dataclass
class Submission:
    contributor: Contributor
    device_id: str
    captured_at: datetime
    duration_sec: int
    point: geo.Point
    gps_accuracy_m: float
    answers: dict
    voice_transcript: str
    fraud_type: str | None = None
    noise: list[str] = field(default_factory=list)
    synced_at: datetime | None = None
    id: str = ""
    client_submission_id: str = ""

    def __post_init__(self) -> None:
        self.point = (round(self.point[0], 6), round(self.point[1], 6))

    @property
    def is_fabricated(self) -> bool:
        return self.fraud_type is not None


@dataclass
class Wave:
    seed: int
    project: dict
    areas: list[Area]
    contributors: list[Contributor]
    submissions: list[Submission]
    check_config: dict
    ring_device: str
    ring_members: list[str]
    burst_account: str


@dataclass(frozen=True)
class _NoisePlan:
    late_capture: frozenset[tuple[str, int]]
    late_sync: frozenset[tuple[str, int]]


# Time helpers ----------------------------------------------------------------

def _at(day: date, hours: float) -> datetime:
    """Wall-clock EAT time on `day`, to the second. hours >= 24 is after midnight."""
    return datetime(day.year, day.month, day.day, tzinfo=cfg.EAT) + timedelta(seconds=round(hours * 3600))


def _minutes(m: float) -> timedelta:
    return timedelta(seconds=round(m * 60))


def _seconds(s: float) -> timedelta:
    return timedelta(seconds=round(s))


# Answer helpers ---------------------------------------------------------------

def _clamp(v: int) -> int:
    return min(5, max(1, v))


def _respondent(rng: Random, area: Area, style: float = 0.0) -> tuple[str, float]:
    """A household's water source and its satisfaction bias."""
    source = rng.choices(cfg.WATER_SOURCES, weights=area.source_weights)[0]
    return source, rng.gauss(0, 0.7) + SOURCE_EFFECT[source] + style


def _satisfaction(rng: Random, bias: float) -> list[int]:
    """Eight varied answers. Straight-lining only ever comes from _straight_line."""
    while True:
        values = [_clamp(round(m + bias + rng.gauss(0, 0.8))) for m in ITEM_MEANS]
        if len(set(values)) > 1:
            return values


def _straight_line(rng: Random, bias: float) -> list[int]:
    return [_clamp(round(3 + bias + rng.gauss(0, 0.4)))] * len(ITEM_MEANS)


def _answers(rng: Random, area: Area, source: str, bias: float, noise: list[str], *,
             short: bool = False, allow_noise: bool = True) -> tuple[dict, str]:
    if allow_noise and rng.random() < STRAIGHTLINE_GENUINE_RATE:
        satisfaction = _straight_line(rng, bias)
        noise.append("straightline_genuine")
    else:
        satisfaction = _satisfaction(rng, bias)
    if allow_noise and rng.random() < TWO_SOURCE_RATE:
        other = rng.choice([s for s in cfg.WATER_SOURCES if s != source])
        transcript = text.two_source_transcript(rng, source, other)
        noise.append("two_source_transcript")
    else:
        transcript = text.voice_transcript(rng, source, area.landmarks)
    answers = {
        "water_source": source,
        "satisfaction": satisfaction,
        "open_text": text.open_text(rng, source, area.landmarks, short=short),
    }
    return answers, transcript


def _accuracy(rng: Random) -> float:
    if rng.random() < 0.05:
        return round(rng.uniform(50, 150), 1)
    return round(rng.uniform(5, 25), 1)


def _interview_minutes(rng: Random) -> float:
    """Normal interview length: about 28 min, sd 7, never under 12."""
    while True:
        m = rng.gauss(28, 7)
        if m >= 12:
            return m


# Sync -------------------------------------------------------------------------

def _assign_sync(rng: Random, batch: list[Submission], when: datetime) -> None:
    """Upload a batch in capture order, a few seconds apart."""
    for sub in sorted(batch, key=lambda s: s.captured_at):
        when += _seconds(rng.uniform(1, 5))
        sub.synced_at = when


def _sync_day_batch(rng: Random, batch: list[Submission], day: date, late: bool) -> None:
    """Enumerators sync on wifi: that evening, the next morning, or (rarely) much later."""
    if not batch:
        return
    last = max(s.captured_at for s in batch)
    if late:
        when = _at(day, 24 + rng.uniform(12.0, 19.0))
        for sub in batch:
            sub.noise.append("late_sync")
    elif rng.random() < 0.65:
        when = max(_at(day, rng.uniform(18.0, 22.0)), last + _minutes(rng.uniform(10, 40)))
        if when > _at(day, 22.5):
            when = _at(day, 24 + rng.uniform(7.0, 9.5))
    else:
        when = _at(day, 24 + rng.uniform(7.0, 9.5))
    _assign_sync(rng, batch, when)


# Enumerators ------------------------------------------------------------------

def _enumerator_fraud(rng: Random, code: str, day_no: int) -> str | None:
    if code == cfg.SPEEDER and rng.random() < 0.55:
        return "speeder"
    if code == cfg.COPYPASTE and day_no >= 2 and rng.random() < 0.5:
        return "copypaste"
    if code == cfg.CONTRADICTION and rng.random() < 0.4:
        return "contradiction"
    return None


def _enumerator_submissions(seed: int, enum: Contributor, plan: _NoisePlan) -> list[Submission]:
    rng = rng_for(seed, "enumerator", enum.code)
    area, ring = enum.area, enum.area.ring
    clusters = [geo.random_point_in(rng, ring, 500) for _ in range(3)]
    tea_shop = geo.random_point_in(rng, ring, 300)
    style = rng.gauss(0, 0.15)  # small interviewer effect on satisfaction
    copy_bases = [text.open_text(rng, rng.choice(cfg.WATER_SOURCES), area.landmarks) for _ in range(3)]
    clean = enum.code not in cfg.FRAUD_ENUMERATORS

    def interview(house: geo.Point, start: datetime, fraud: str | None, noise: list[str],
                  exact_point: bool = False) -> Submission:
        if fraud == "speeder":
            minutes = rng.uniform(4, 9)
        elif fraud is None and rng.random() < SHORT_GENUINE_RATE:
            minutes = rng.uniform(8, 11.9)
            noise.append("short_genuine")
        else:
            minutes = _interview_minutes(rng)

        if fraud == "contradiction":
            # The household buys water or uses the river; the form says piped_home.
            true_source = rng.choice(("vendor", "river"))
            bias = rng.gauss(0, 0.7) + SOURCE_EFFECT[true_source] + style
            answers = {
                "water_source": "piped_home",
                "satisfaction": _satisfaction(rng, bias),
                "open_text": text.open_text(rng, true_source, area.landmarks),
            }
            transcript = text.voice_transcript(rng, true_source, area.landmarks)
        else:
            source, bias = _respondent(rng, area, style)
            answers, transcript = _answers(rng, area, source, bias, noise, allow_noise=fraud is None)
            if fraud == "speeder":
                answers["open_text"] = text.open_text(rng, source, area.landmarks, short=True)
                if rng.random() < 0.8:
                    answers["satisfaction"] = [rng.choice((3, 4, 4, 5))] * len(ITEM_MEANS)
            elif fraud == "copypaste":
                base = rng.choice(copy_bases)
                answers["open_text"] = base if rng.random() < 0.4 else text.one_word_variant(rng, base)

        accuracy = _accuracy(rng)
        point = house if exact_point else geo.scatter(rng, ring, house, accuracy / 2, accuracy)
        duration = round(minutes * 60)
        return Submission(enum, enum.device_id, start + timedelta(seconds=duration), duration,
                          point, accuracy, answers, transcript, fraud, noise)

    out: list[Submission] = []
    for day_no, day in enumerate(cfg.FIELD_DAYS, start=1):
        cluster = clusters[(day_no - 1) // 2]  # a new village cluster every two days
        batch: list[Submission] = []
        n = rng.randint(6, 8)
        curbstoning = enum.code == cfg.CURBSTONE and day_no >= 3
        n_tea = round(n * rng.uniform(0.5, 0.7)) if curbstoning else 0
        n_field = n - n_tea

        # Genuine compound: three households within ~30 m, interviewed back to back.
        compound_from, compound = None, cluster
        if clean and rng.random() < COMPOUND_DAY_RATE:
            compound_from = rng.randint(0, n_field - 3)
            compound = geo.scatter(rng, ring, cluster, 110, 300)

        t = _at(day, rng.uniform(8.0, 9.25))
        prev: geo.Point | None = None
        lunch = False
        for i in range(n_field):
            in_compound = compound_from is not None and compound_from <= i < compound_from + 3
            if in_compound:
                house = geo.scatter(rng, ring, compound, 8, 15)
            else:
                house = geo.scatter(rng, ring, cluster, 110, 300)
            if prev is None:
                gap = 0.0
            elif in_compound and i > compound_from:
                gap = rng.uniform(2, 5)
            else:
                # Walking plus finding the household and getting consent.
                gap = geo.distance_m(prev, house) / WALK_M_PER_MIN + rng.uniform(8, 25)
                if rng.random() < 0.15:
                    gap += rng.uniform(20, 60)  # nobody home, a refusal or a call-back
            if not lunch and t.hour >= 12:
                gap += rng.uniform(40, 75)
                lunch = True
            noise = ["compound_cluster"] if in_compound else []
            sub = interview(house, t + _minutes(gap), _enumerator_fraud(rng, enum.code, day_no),
                            noise, exact_point=in_compound)
            if sub.captured_at > _at(day, WORKDAY_END_HOUR):
                break
            batch.append(sub)
            t, prev = sub.captured_at, house

        if n_tea:
            # Curbstoning: the rest of the day's forms filled in at one tea shop.
            t = max(t + _minutes(rng.uniform(20, 40)), _at(day, rng.uniform(13.5, 15.0)))
            for j in range(n_tea):
                start = t + _minutes(rng.uniform(1, 4)) if j else t
                duration = round(rng.uniform(9, 15) * 60)
                source, bias = _respondent(rng, area, style)
                answers, transcript = _answers(rng, area, source, bias, [], allow_noise=False)
                sub = Submission(enum, enum.device_id, start + timedelta(seconds=duration), duration,
                                 geo.scatter(rng, ring, tea_shop, 4, 12), round(rng.uniform(6, 15), 1),
                                 answers, transcript, "curbstone")
                batch.append(sub)
                t = sub.captured_at

        if (enum.code, day_no) in plan.late_capture:
            # A genuine call-back that finishes around 21:00-21:30.
            end = _at(day, rng.uniform(21.0, 21.5))
            sub = interview(geo.scatter(rng, ring, cluster, 110, 300), end, None, ["late_capture"])
            sub.captured_at = end
            batch.append(sub)

        _sync_day_batch(rng, batch, day, late=(enum.code, day_no) in plan.late_sync)
        out.extend(batch)

        if enum.code == cfg.NIGHT and day_no >= 4:
            # Forms invented at home between 22:00 and 01:00, synced next morning.
            night: list[Submission] = []
            t = _at(day, rng.uniform(22.0, 22.4))
            for j in range(rng.randint(3, 4)):
                start = t + _minutes(rng.uniform(2, 8)) if j else t
                duration = round(rng.uniform(10, 18) * 60)
                source, bias = _respondent(rng, area, style)
                answers, transcript = _answers(rng, area, source, bias, [], allow_noise=False)
                sub = Submission(enum, enum.device_id, start + timedelta(seconds=duration), duration,
                                 geo.scatter(rng, ring, enum.home, 5, 15), round(rng.uniform(8, 25), 1),
                                 answers, transcript, "night")
                night.append(sub)
                t = sub.captured_at
            _assign_sync(rng, night, _at(day, 24 + rng.uniform(6.5, 8.0)))
            out.extend(night)
    return out


# Participants -----------------------------------------------------------------

def _daytime_slots(rng: Random, days: list[date], n: int) -> list[datetime]:
    """n start times between 07:00 and 20:00 EAT, at least an hour apart."""
    slots: list[datetime] = []
    while len(slots) < n:
        t = _at(rng.choice(days), rng.uniform(7.0, 20.0))
        if all(abs((t - s).total_seconds()) >= 3600 for s in slots):
            slots.append(t)
    return sorted(slots)


def _mobile_sync(rng: Random, captured: datetime) -> datetime:
    """Participants are on mobile data: synced within seconds to minutes."""
    return captured + _seconds(min(600.0, max(5.0, rng.lognormvariate(math.log(60), 0.8))))


def _participant_submissions(seed: int, p: Contributor, burst: bool) -> list[Submission]:
    rng = rng_for(seed, "participant", p.code)
    area = p.area
    source, bias = _respondent(rng, area)
    other = rng.choice([s for s in cfg.WATER_SOURCES if s != source])
    burst_day = rng.choice(cfg.FIELD_DAYS[2:5]) if burst else None
    days = [d for d in cfg.FIELD_DAYS if d != burst_day]

    out: list[Submission] = []
    for start in _daytime_slots(rng, days, rng.randint(3, 6) if burst else rng.randint(3, 10)):
        duration = round(rng.triangular(4, 15, 7) * 60)
        noise: list[str] = []
        used = source if rng.random() < 0.85 else other
        answers, transcript = _answers(rng, area, used, bias, noise, short=True)
        sub = Submission(p, p.device_id, start + timedelta(seconds=duration), duration,
                         geo.scatter(rng, area.ring, p.home, 15, 40), _accuracy(rng),
                         answers, transcript, None, noise)
        sub.synced_at = _mobile_sync(rng, sub.captured_at)
        out.append(sub)

    if burst:
        out.extend(_burst(rng, p, source, bias, burst_day))
    return out


def _burst(rng: Random, p: Contributor, source: str, bias: float, day: date) -> list[Submission]:
    """About 25 near-identical submissions in roughly an hour, to farm points."""
    base_satisfaction = _satisfaction(rng, bias)
    base_text = text.open_text(rng, source, p.area.landmarks, short=True)
    base_voice = text.voice_transcript(rng, source, p.area.landmarks)
    spot = geo.scatter(rng, p.area.ring, p.home, 10, 25)
    t = _at(day, rng.uniform(10.0, 17.0))
    out: list[Submission] = []
    for j in range(rng.randint(23, 27)):
        start = t + _seconds(rng.uniform(10, 60)) if j else t
        duration = rng.randint(55, 150)
        satisfaction = list(base_satisfaction)
        if rng.random() < 0.3:
            i = rng.randrange(len(satisfaction))
            satisfaction[i] = _clamp(satisfaction[i] + rng.choice((-1, 1)))
        answers = {
            "water_source": source,
            "satisfaction": satisfaction,
            "open_text": base_text if rng.random() < 0.6 else text.one_word_variant(rng, base_text),
        }
        voice = base_voice if rng.random() < 0.8 else text.voice_transcript(rng, source, p.area.landmarks)
        sub = Submission(p, p.device_id, start + timedelta(seconds=duration), duration,
                         geo.scatter(rng, p.area.ring, spot, 3, 8), round(rng.uniform(5, 15), 1),
                         answers, voice, "burst")
        sub.synced_at = sub.captured_at + _seconds(rng.uniform(8, 90))
        out.append(sub)
        t = sub.captured_at
    return out


def _ring_submissions(seed: int, members: list[Contributor], device: str) -> list[Submission]:
    """Four accounts on one phone, submitting in bursts on the same days with similar answers."""
    rng = rng_for(seed, "ring")
    area = members[0].area
    spot = members[0].home
    source, bias = _respondent(rng, area)
    other = rng.choice([s for s in cfg.WATER_SOURCES if s != source])
    base_satisfaction = _satisfaction(rng, bias)
    bases = [text.open_text(rng, source, area.landmarks, short=True) for _ in range(2)]

    out: list[Submission] = []
    for day in sorted(rng.sample(list(cfg.FIELD_DAYS), 3)):
        queue = [m for m in members for _ in range(rng.randint(1, 3))]
        rng.shuffle(queue)
        t = _at(day, rng.uniform(9.0, 16.5))
        for j, member in enumerate(queue):
            start = t + _minutes(rng.uniform(0.5, 3)) if j else t
            duration = round(rng.uniform(3, 6) * 60)
            used = source if rng.random() < 0.9 else other
            base = rng.choice(bases)
            answers = {
                "water_source": used,
                "satisfaction": [_clamp(v + rng.choice((-1, 0, 0, 0, 1))) for v in base_satisfaction],
                "open_text": base if rng.random() < 0.5 else text.one_word_variant(rng, base),
            }
            sub = Submission(member, device, start + timedelta(seconds=duration), duration,
                             geo.scatter(rng, area.ring, spot, 6, 20), round(rng.uniform(5, 20), 1),
                             answers, text.voice_transcript(rng, used, area.landmarks), "multi_account")
            sub.synced_at = sub.captured_at + _seconds(rng.uniform(10, 120))
            out.append(sub)
            t = sub.captured_at
    return out


# Assembly ---------------------------------------------------------------------

def _noise_plan(seed: int, enumerators: list[Contributor]) -> _NoisePlan:
    rng = rng_for(seed, "noise-plan")
    days = [(e.code, d) for e in enumerators if e.code not in cfg.FRAUD_ENUMERATORS
            for d in range(1, len(cfg.FIELD_DAYS) + 1)]
    picked = rng.sample(days, LATE_CAPTURE_DAYS + LATE_SYNC_DAYS)
    return _NoisePlan(frozenset(picked[:LATE_CAPTURE_DAYS]), frozenset(picked[LATE_CAPTURE_DAYS:]))


def _assign_ids(seed: int, subs: list[Submission]) -> None:
    by_code: dict[str, list[Submission]] = {}
    for sub in subs:
        by_code.setdefault(sub.contributor.code, []).append(sub)
    for code, items in by_code.items():
        for i, sub in enumerate(sorted(items, key=lambda s: s.captured_at), start=1):
            sub.id = make_uuid(seed, "submission", code, i)
            sub.client_submission_id = make_uuid(seed, "client-submission", code, i)


def build_wave(seed: int) -> Wave:
    areas = [
        Area(make_uuid(seed, "area", spec.name), spec.name, cfg.area_ring(spec),
             spec.source_weights, spec.landmarks)
        for spec in cfg.AREAS
    ]
    names_rng, taken = rng_for(seed, "names"), set()

    def contributor(code: str, kind: str, area: Area, created: datetime, margin_m: float) -> Contributor:
        home = geo.random_point_in(rng_for(seed, "home", code), area.ring, margin_m)
        return Contributor(make_uuid(seed, "contributor", code), code, text.display_name(names_rng, taken),
                           kind, area, device_id(seed, code), home, created)

    enumerators = [
        contributor(f"E{n:02d}", "enumerator", areas[(n - 1) // cfg.ENUMERATORS_PER_AREA],
                    ENUMERATORS_REGISTERED + timedelta(minutes=n), 300)
        for n in range(1, len(areas) * cfg.ENUMERATORS_PER_AREA + 1)
    ]
    participants = [
        contributor(f"P{n:02d}", "participant", areas[(n - 1) // cfg.PARTICIPANTS_PER_AREA],
                    PARTICIPANTS_REGISTERED + timedelta(minutes=7 * n), 250)
        for n in range(1, len(areas) * cfg.PARTICIPANTS_PER_AREA + 1)
    ]

    actors = rng_for(seed, "actors")
    ring_area = actors.choice(areas)
    ring_members = sorted(actors.sample([p for p in participants if p.area is ring_area], 4),
                          key=lambda c: c.code)
    burst_account = actors.choice([p for p in participants if p.area is not ring_area])
    ring_device = device_id(seed, "ring")
    for member in ring_members:
        member.device_id = ring_device
    ring_codes = {m.code for m in ring_members}

    plan = _noise_plan(seed, enumerators)
    subs: list[Submission] = []
    for enum in enumerators:
        subs.extend(_enumerator_submissions(seed, enum, plan))
    for p in participants:
        if p.code not in ring_codes:
            subs.extend(_participant_submissions(seed, p, burst=p is burst_account))
    subs.extend(_ring_submissions(seed, ring_members, ring_device))
    _assign_ids(seed, subs)
    subs.sort(key=lambda s: (s.captured_at, s.contributor.code))

    project_id = make_uuid(seed, "project")
    project = {
        "id": project_id,
        "name": cfg.PROJECT_NAME,
        "region": cfg.PROJECT_REGION,
        "start_date": cfg.FIELD_DAYS[0].isoformat(),
        "end_date": cfg.FIELD_DAYS[-1].isoformat(),
        "created_at": PROJECT_CREATED.isoformat(),
    }
    check_config = {
        "project_id": project_id,
        "params": dict(cfg.DEFAULT_CHECK_PARAMS),
        "updated_at": PROJECT_CREATED.isoformat(),
    }
    return Wave(seed, project, areas, [*enumerators, *participants], subs, check_config,
                ring_device, [m.code for m in ring_members], burst_account.code)


def _utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def db_rows(wave: Wave) -> dict[str, list[dict]]:
    """Rows per table, in insert order, exactly as they are written to Supabase."""
    project_id = wave.project["id"]
    return {
        "projects": [wave.project],
        "areas": [
            {"id": a.id, "project_id": project_id, "name": a.name,
             "boundary": {"type": "Polygon", "coordinates": [a.ring]}}
            for a in wave.areas
        ],
        "contributors": [
            {"id": c.id, "project_id": project_id, "code": c.code, "display_name": c.display_name,
             "kind": c.kind, "area_id": c.area.id, "created_at": _utc(c.created_at)}
            for c in wave.contributors
        ],
        "check_config": [wave.check_config],
        "submissions": [
            {
                "id": s.id,
                "project_id": project_id,
                "contributor_id": s.contributor.id,
                "client_submission_id": s.client_submission_id,
                "device_id": s.device_id,
                "captured_at": _utc(s.captured_at),
                "synced_at": _utc(s.synced_at),
                "duration_sec": s.duration_sec,
                "lat": s.point[1],
                "lng": s.point[0],
                "gps_accuracy_m": s.gps_accuracy_m,
                "answers": s.answers,
                "voice_note_path": None,
                "voice_transcript": s.voice_transcript,
                "transcript_lang": "en",
                "source": "synthetic",
                "created_at": _utc(s.synced_at),
            }
            for s in wave.submissions
        ],
        "synthetic_truth": [
            {"submission_id": s.id, "is_fabricated": s.is_fabricated, "fraud_type": s.fraud_type}
            for s in wave.submissions
        ],
    }
