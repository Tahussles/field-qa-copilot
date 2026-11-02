"""The morning brief: facts from /overview in, a model-written brief out, checked against the facts.

Only aggregates go to the model (no rows, no transcripts) and contributors are
codes, never names. Every number in the model's text must appear in the facts;
a brief that fails is regenerated once, then the dashboard falls back to its
template. Briefs are cached per (project, day, data version), the version being
a hash of the facts.
"""

import hashlib
import json
import re

from .ai import BriefOut

# Same order as mainSignal in lib/checks.ts: the check that fired most, ties in this order.
TIE_ORDER = ("shared_device", "same_spot", "burst", "copied_text", "voice_vs_form", "straight_lining",
             "off_hours", "too_fast")
CHECK_NAMES = {
    "too_fast": "too fast", "same_spot": "same spot", "copied_text": "copied text",
    "straight_lining": "straight-lining", "voice_vs_form": "voice vs form", "off_hours": "off hours",
    "shared_device": "shared device", "burst": "burst",
}
MAX_CONTRIBUTORS = 6


def ranked_checks(checks_fired: dict[str, int]) -> list[tuple[str, int]]:
    return sorted(((k, n) for k, n in checks_fired.items() if n), key=lambda kv: (-kv[1], TIE_ORDER.index(kv[0])))


def _pct(part: int, whole: int) -> float:
    return round(100 * part / whole, 1) if whole else 0.0


def facts(overview: dict) -> dict:
    """The numbers the brief may use, already formatted the way it should write them."""
    y, t = overview["yesterday"], overview["today"]
    biggest: dict[str, dict] = {}
    for h in overview["hotspots"]:
        if h["contributor_code"] not in biggest or h["count"] > biggest[h["contributor_code"]]["count"]:
            biggest[h["contributor_code"]] = h
    people = []
    for c in [c for c in overview["contributors"] if c["status"] == "investigate"][:MAX_CONTRIBUTORS]:
        ranked = ranked_checks(c.get("checks_fired") or {})
        person = {
            "code": c["code"],
            "kind": c["kind"],
            "area": c.get("area"),
            "submissions": c["submissions"],
            "flagged": c["flagged"],
            "flagged_pct": round(100 * c["flag_rate"]),
            "main_signal": CHECK_NAMES[ranked[0][0]] if ranked else None,
            "checks_fired": {CHECK_NAMES[k]: n for k, n in ranked[:3]},
        }
        spot = biggest.get(c["code"])
        if spot and ranked and ranked[0][0] == "same_spot":
            person["hotspot_interviews_in_one_spot"] = spot["count"]
            if spot["mostly_off_hours"]:
                person["hotspot_timing"] = "mostly after 22:00"
        people.append(person)
    areas = sorted(overview["areas"], key=lambda a: -a["flag_rate"])
    return {
        "yesterday": {
            "date": y["date"], "received": y["received"], "flagged": y["flagged"],
            "flagged_pct": _pct(y["flagged"], y["received"]),
            "median_interview_minutes": round(y["median_duration_sec"] / 60) if y.get("median_duration_sec") else None,
        },
        "today_so_far": {"date": t["date"], "received": t["received"], "flagged": t["flagged"]},
        "contributors_to_investigate": people,
        "more_to_investigate": max(0, sum(c["status"] == "investigate" for c in overview["contributors"]) - len(people)),
        "watch_list": [c["code"] for c in overview["contributors"] if c["status"] == "watch"],
        "review_queue_waiting": overview["kpis"]["pending_review"],
        "highest_flag_rate_area": (
            {"area": areas[0]["area"], "flagged_pct": round(100 * areas[0]["flag_rate"])} if areas else None),
    }


def data_version(facts_: dict) -> str:
    return hashlib.sha256(json.dumps(facts_, sort_keys=True).encode()).hexdigest()[:16]


# Numbers check -------------------------------------------------------------------------

_IDS = re.compile(r"\b[EP]\d{2}\b|\bS-[0-9A-F]{4}\b")
_NUMBER = re.compile(r"(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)")


def _numbers(text: str) -> list[str]:
    return [format(float(n.replace(",", "")), "g") for n in _NUMBER.findall(_IDS.sub(" ", text))]


def unknown_numbers(brief: BriefOut, facts_: dict) -> list[str]:
    """Numbers in the brief that do not appear anywhere in the facts (contributor codes do not count)."""
    allowed = set(_numbers(json.dumps(facts_)))
    texts = [brief.summary, brief.closing] + [f"{i.finding} {i.action}" for i in brief.items]
    return sorted({n for text in texts for n in _numbers(text) if n not in allowed})


def check(brief: BriefOut, facts_: dict) -> str | None:
    """Why a brief is unusable, or None."""
    missing = unknown_numbers(brief, facts_)
    if missing:
        return f"numbers not in the input: {', '.join(missing[:6])}"
    known = {p["code"] for p in facts_["contributors_to_investigate"]} | set(facts_["watch_list"])
    strangers = [i.contributor_code for i in brief.items if i.contributor_code not in known]
    if strangers:
        return f"contributors not in the input: {', '.join(strangers)}"
    return None


def markdown(brief: BriefOut) -> str:
    lines = [brief.summary, ""]
    lines += [f"- **{i.contributor_code}** {i.finding}\n  → {i.action}" for i in brief.items]
    if brief.closing:
        lines += ["", brief.closing]
    return "\n".join(lines)


def speech(brief: BriefOut) -> str:
    """What the Listen button reads: the brief as sentences, codes spelled out."""
    spell = lambda code: " ".join(code)  # noqa: E731  "E07" reads better as "E 0 7"
    parts = [brief.summary]
    parts += [f"{spell(i.contributor_code)}: {i.finding} {i.action}" for i in brief.items]
    if brief.closing:
        parts.append(brief.closing)
    return " ".join(parts)
