"""Aggregates over scored submissions for the dashboard: hotspots, contributor stats, area rates.

Pure functions over engine inputs and outputs, like the checks.
"""

from collections import Counter, defaultdict
from statistics import fmean, median
from typing import Iterable, Mapping
from zoneinfo import ZoneInfo

from .config import Params
from .geo import haversine_m
from .model import Contributor, Submission, iso_utc
from .scoring import ScoredSubmission

HOTSPOT_MIN_COUNT = 4
HOTSPOT_LINK_FACTOR = 2.0  # link points within 2 x same_spot_radius_m
INVESTIGATE_MIN_FLAGGED = 3


def _fired(scored: ScoredSubmission, key: str) -> bool:
    return any(r.key == key and r.fired for r in scored.results)


def hotspots(scored: Iterable[ScoredSubmission], submissions: Iterable[Submission],
             contributors: Mapping[str, Contributor], params: Params,
             min_count: int = HOTSPOT_MIN_COUNT) -> list[dict]:
    """Places where one enumerator keeps logging same_spot interviews, across days.

    Single-link clustering of an enumerator's same_spot-fired submissions with
    link distance 2 x same_spot_radius_m; clusters of at least min_count.
    """
    tz = ZoneInfo(params.timezone)
    by_id = {s.id: s for s in submissions}
    groups: dict[str, list[tuple[Submission, ScoredSubmission]]] = defaultdict(list)
    for result in scored:
        sub = by_id.get(result.submission_id)
        if sub and sub.lat is not None and sub.lng is not None and _fired(result, "same_spot"):
            groups[sub.contributor_id].append((sub, result))

    link_m = HOTSPOT_LINK_FACTOR * params.same_spot_radius_m
    found = []
    for contributor_id, members in groups.items():
        members.sort(key=lambda m: (m[0].captured_at, m[0].id))
        parent = list(range(len(members)))

        def root(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                a, b = members[i][0], members[j][0]
                if haversine_m(a.lat, a.lng, b.lat, b.lng) <= link_m:
                    parent[root(j)] = root(i)

        clusters: dict[int, list[tuple[Submission, ScoredSubmission]]] = defaultdict(list)
        for i, member in enumerate(members):
            clusters[root(i)].append(member)
        for cluster in clusters.values():
            if len(cluster) < min_count:
                continue
            subs = [m[0] for m in cluster]
            lat, lng = fmean(s.lat for s in subs), fmean(s.lng for s in subs)
            durations = [s.duration_sec for s in subs if s.duration_sec is not None]
            off_hours = sum(_fired(m[1], "off_hours") for m in cluster)
            dates = sorted(s.local_date(tz) for s in subs)
            found.append({
                "contributor_id": contributor_id,
                "contributor_code": contributors[contributor_id].code,
                "count": len(subs),
                "centroid": {"lat": round(lat, 6), "lng": round(lng, 6)},
                "radius_m": round(max(haversine_m(lat, lng, s.lat, s.lng) for s in subs), 1),
                "first_date": dates[0].isoformat(),
                "last_date": dates[-1].isoformat(),
                "days": len(set(dates)),
                "avg_duration_sec": round(fmean(durations)) if durations else None,
                "off_hours_share": round(off_hours / len(subs), 3),
                "mostly_off_hours": off_hours * 2 > len(subs),
                "submission_ids": [s.id for s in subs],
            })
    found.sort(key=lambda h: (-h["count"], h["contributor_code"], h["first_date"]))
    return found


def contributor_stats(scored: Iterable[ScoredSubmission], submissions: Iterable[Submission],
                      contributors: Mapping[str, Contributor], params: Params) -> list[dict]:
    """One row per contributor with submissions, most flagged first."""
    by_id = {s.id: s for s in submissions}
    rows: dict[str, dict] = {}
    durations: dict[str, list[int]] = defaultdict(list)
    for result in scored:
        sub = by_id.get(result.submission_id)
        if sub is None:
            continue
        row = rows.setdefault(sub.contributor_id, {
            "submissions": 0, "flagged": 0, "watch": 0, "score_sum": 0.0,
            "checks": Counter(), "last_captured_at": sub.captured_at,
        })
        row["submissions"] += 1
        band = params.band(result.score)
        row["flagged"] += band == "flagged"
        row["watch"] += band == "watch"
        row["score_sum"] += result.score
        row["checks"].update(r.key for r in result.results if r.fired)
        row["last_captured_at"] = max(row["last_captured_at"], sub.captured_at)
        if sub.duration_sec is not None:
            durations[sub.contributor_id].append(sub.duration_sec)

    out = []
    for contributor_id, row in rows.items():
        contributor = contributors[contributor_id]
        out.append({
            "contributor_id": contributor_id,
            "code": contributor.code,
            "kind": contributor.kind,
            "submissions": row["submissions"],
            "flagged": row["flagged"],
            "watch": row["watch"],
            "flag_rate": round(row["flagged"] / row["submissions"], 3),
            "mean_score": round(row["score_sum"] / row["submissions"], 2),
            "median_duration_sec": median(durations[contributor_id]) if durations[contributor_id] else None,
            "checks_fired": dict(sorted(row["checks"].items())),
            "last_captured_at": iso_utc(row["last_captured_at"]),
            "investigate": row["flagged"] >= INVESTIGATE_MIN_FLAGGED,
        })
    out.sort(key=lambda r: (-r["flagged"], -r["flag_rate"], r["code"]))
    return out


def area_rates(scored: Iterable[ScoredSubmission], submissions: Iterable[Submission],
               area_of: Mapping[str, str], params: Params) -> list[dict]:
    """Flag and watch rates per area. area_of maps contributor_id to an area name."""
    by_id = {s.id: s for s in submissions}
    counts: dict[str, Counter] = defaultdict(Counter)
    for result in scored:
        sub = by_id.get(result.submission_id)
        if sub is None:
            continue
        area = area_of.get(sub.contributor_id, "unknown")
        counts[area]["submissions"] += 1
        counts[area][params.band(result.score)] += 1
    return [
        {"area": area, "submissions": c["submissions"], "flagged": c["flagged"], "watch": c["watch"],
         "flag_rate": round(c["flagged"] / c["submissions"], 3)}
        for area, c in sorted(counts.items(), key=lambda kv: (-kv[1]["flagged"] / kv[1]["submissions"], kv[0]))
    ]
