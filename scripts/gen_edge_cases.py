"""Ask a model for adversarial and boundary test cases per check, for a human to review.

    uv run scripts/gen_edge_cases.py --estimate               # what it would cost; no call
    uv run scripts/gen_edge_cases.py                          # ~5 cases for each of the 9 checks
    uv run scripts/gen_edge_cases.py --check burst --per-check 8
    uv run scripts/gen_edge_cases.py --review                 # run every proposed case through the engine

The model gets each check's rule in plain words and the thresholds (never the
code), and answers in strict JSON: the submissions, the target, which checks
should and should not fire on it, and why. Every case is validated with pydantic
(datagen/edge_cases.py) and written to data/fixtures/edge_cases/proposed/<id>.json.

Nothing proposed is trusted. A human reviews each case: accepted ones move to
accepted/, where tests/test_edge_cases.py runs them deterministically. A case
the engine disagrees with is either a wrong expectation (reject it) or a real
gap in a check (report it; do not bend the case to the code).
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import anthropic  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from api._lib.postgrest import load_env  # noqa: E402
from datagen.edge_cases import AREAS, EDGE_CASES, ROSTER, TIMEZONE, WATER_SOURCES, EdgeCase, mismatches, slug  # noqa: E402
from engine import CHECK_KEYS, Params  # noqa: E402

MODEL = "claude-opus-5-5"
PRICE = (4.00, 20.00)  # USD per million input / output tokens
EST_TOKENS = (4_000, 14_000)  # per check, output includes thinking at high effort
PROMPT_VERSION = "edge-v2"  # v2: engine 0.5.0 rules (GPS tolerance, zig-zag, whole-word keywords)

P = Params()
RULES = {
    "too_fast": f"Fires when duration_sec is below the minimum for the contributor's kind: enumerators "
                f"{P.too_fast_min_minutes['enumerator']:g} minutes, participants {P.too_fast_min_minutes['participant']:g} "
                "minutes (strictly below; exactly the minimum does not fire).",
    "same_spot": f"Enumerators only. Fires when at least {P.same_spot_min_neighbours} of the same enumerator's other "
                 f"submissions on the same local calendar day (project time zone) lie within {P.same_spot_radius_m:g} m "
                 "of this one (a neighbour exactly on the radius counts). Never fires for participants.",
    "copied_text": f"Fires when the open_text is a near-duplicate of the open_text of another submission by the same "
                   "contributor or from the same device (at any time, before or after): Jaccard similarity of their "
                   "content words (lowercased, English stop words removed) at or above "
                   f"{P.copy_similarity:g}. Empty open_text never fires.",
    "straight_lining": "Fires when all 8 satisfaction answers are identical, or when they strictly alternate between "
                       "two values (5, 4, 5, 4, ...). Any other pattern, even all within one point, stays silent.",
    "voice_vs_form": "Without a model verdict (as here) a keyword rule decides: the earliest water-source keyword "
                     "in the voice transcript names the source heard (ties go to the longer keyword); it fires when "
                     "that source differs from the form's water_source. Keywords: piped_home = our own tap, own tap, "
                     "tap at home, tap in the compound, tap inside, piped, pipe, pipeline, connected; public_tap = "
                     "public tap, communal tap, kiosk, water point; borehole = borehole, hand pump, pump; vendor = "
                     "vendor, handcart, boda boda, water seller; river = river, stream, lake. Keywords match whole "
                     "words, plurals included ('kiosks'), never part of a longer word ('pumpkins', 'lakeside'). "
                     "'buy from' reads as vendor only when the transcript names none of those sources. No keyword, "
                     "or no transcript, never fires.",
    "off_hours": f"Fires when captured_at, in the project time zone ({TIMEZONE}, UTC+3), is at or after "
                 f"{P.off_hours_start} or before {P.off_hours_end}. Only captured_at counts, never the sync time.",
    "shared_device": f"Fires when the device_id has submissions from at least {P.shared_device_min_accounts} "
                     "different contributors in the project (at any time, before or after this one).",
    "burst": f"Fires when some window of {P.burst_window_minutes:g} minutes that contains this submission holds at least "
             f"{P.burst_min_count['enumerator']} (enumerators) or {P.burst_min_count['participant']} (participants) "
             "submissions by the same contributor, this one included, by captured_at (window ends inclusive).",
    "outside_area": f"Fires when the GPS point is outside the contributor's assigned area polygon by more than "
                    f"{P.outside_area_min_tolerance_m:g} m (no GPS accuracy is reported in these cases). Within "
                    f"{P.outside_area_far_m:g} m of the area it weighs {P.outside_area_near_weight:g}, beyond it "
                    f"{P.weights['outside_area']:g}.",
    "clock_skew": "The phones in these cases report no clock of their own, so clock_skew never fires here.",
}

SYSTEM = f"""You write test cases for the quality checks of a household water survey app. Field contributors \
submit interviews from phones; each check is a deterministic rule that fires on a submission or not. Your cases \
find the places where a rule's edges are easy to get wrong: exact thresholds, off-by-one windows, time zones and \
midnight, units, a check that should stay silent when a near-miss tempts it, and adversarial submissions a \
fabricator would craft to slip past one check.

The fixed world every case runs in:
- Project time zone {TIMEZONE} (UTC+3, no daylight saving). Write captured_at as ISO 8601 with an offset.
- Areas, as (lng, lat) rectangles: {json.dumps({k: [v[0], v[2]] for k, v in AREAS.items()})} (south-west and \
north-east corners).
- Contributors: {json.dumps({code: {"kind": kind, "area": area} for code, (kind, area) in ROSTER.items()})}.
- water_source is one of {", ".join(WATER_SOURCES)}. satisfaction is 8 answers from 1 to 5. voice_transcript is \
"" when there is no voice note.
- A submission scores the sum of the weights of the checks that fire on it; every check runs on every submission.

The checks:
{chr(10).join(f"- {k}: {v}" for k, v in RULES.items())}

For each case: the submissions (2 to 10 usually; refs are short lowercase names), the target ref the expectation \
is about, should_fire and should_not_fire (check keys, only ones you are sure of from the rules above, always \
including the check the case is about), and why: which edge it probes and what a wrong implementation would do. \
Make the other checks quiet unless you mean them: realistic durations, varied satisfaction answers, distinct \
open_text per submission, daytime interviews, points inside the contributor's area, one device per contributor. \
Work out every distance, time difference and word overlap you rely on; a case with a wrong expectation is worse \
than no case."""

_STR = {"type": "string"}
_KEYS = {"type": "array", "items": {"type": "string", "enum": list(CHECK_KEYS)}}
SCHEMA = {
    "type": "object",
    "properties": {"cases": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "id": _STR, "check": {"type": "string", "enum": list(CHECK_KEYS)},
            "kind": {"type": "string", "enum": ["boundary", "adversarial"]}, "title": _STR,
            "submissions": {"type": "array", "items": {
                "type": "object",
                "properties": {
                    "ref": _STR, "contributor": {"type": "string", "enum": list(ROSTER)}, "device_id": _STR,
                    "captured_at": _STR, "duration_sec": {"type": "integer"}, "lat": {"type": "number"},
                    "lng": {"type": "number"}, "water_source": {"type": "string", "enum": list(WATER_SOURCES)},
                    "satisfaction": {"type": "array", "items": {"type": "integer"}}, "open_text": _STR,
                    "voice_transcript": _STR,
                },
                "required": ["ref", "contributor", "device_id", "captured_at", "duration_sec", "lat", "lng",
                             "water_source", "satisfaction", "open_text", "voice_transcript"],
                "additionalProperties": False,
            }},
            "target": _STR, "should_fire": _KEYS, "should_not_fire": _KEYS, "why": _STR,
        },
        "required": ["id", "check", "kind", "title", "submissions", "target", "should_fire", "should_not_fire", "why"],
        "additionalProperties": False,
    }}},
    "required": ["cases"],
    "additionalProperties": False,
}


def cost(input_tokens: int, output_tokens: int) -> float:
    return round((input_tokens * PRICE[0] + output_tokens * PRICE[1]) / 1_000_000, 4)


def generate(client: anthropic.Anthropic, check: str, count: int) -> tuple[list[EdgeCase], list[str], dict]:
    started = time.perf_counter()
    with client.messages.stream(
        model=MODEL,
        max_tokens=32_000,
        system=SYSTEM,
        messages=[{"role": "user", "content": f"Write {count} cases for {check}: mostly boundary cases on its "
                                              "thresholds, and at least one adversarial case. Give each an id that "
                                              f"starts with {check.replace('_', '-')}-."}],
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": SCHEMA}},
    ) as stream:
        message = stream.get_final_message()
    usage = {"input_tokens": message.usage.input_tokens, "output_tokens": message.usage.output_tokens,
             "latency_ms": round((time.perf_counter() - started) * 1000),
             "cost_usd": cost(message.usage.input_tokens, message.usage.output_tokens), "stop_reason": message.stop_reason}
    if message.stop_reason != "end_turn":
        return [], [f"{check}: stopped with {message.stop_reason}"], usage
    text = next(b.text for b in message.content if b.type == "text")
    cases, invalid = [], []
    for raw in json.loads(text)["cases"]:
        try:
            cases.append(EdgeCase.model_validate({**raw, "id": slug(raw.get("id") or raw.get("title", ""))}))
        except ValidationError as error:
            invalid.append(f"{check}: {raw.get('id')}: {error.errors()[0]['msg']}")
    return cases, invalid, usage


def review() -> int:
    """Each proposed case against the engine: agrees, or how it disagrees."""
    for path in sorted((EDGE_CASES / "proposed").glob("*.json")):
        case = EdgeCase.model_validate(json.loads(path.read_text())["case"])
        wrong = mismatches(case)
        print(f"{'agree   ' if not wrong else 'DISAGREE'} {case.id}: {'; '.join(wrong) or 'as expected'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="append", choices=CHECK_KEYS, help="only these checks (default: all)")
    parser.add_argument("--per-check", type=int, default=5)
    parser.add_argument("--estimate", action="store_true")
    parser.add_argument("--review", action="store_true", help="run the proposed cases through the engine")
    parser.add_argument("--max-usd", type=float, default=5.0)
    args = parser.parse_args()
    if args.review:
        return review()

    checks = args.check or list(CHECK_KEYS)
    estimate = len(checks) * cost(*EST_TOKENS)
    print(f"{len(checks)} calls to {MODEL} ({args.per_check} cases each): estimated ${estimate:.2f}")
    if args.estimate:
        return 0
    if estimate > args.max_usd:
        print(f"stopping: over ${args.max_usd:.2f}", file=sys.stderr)
        return 3
    local = ROOT / ".env.local"
    key = (load_env(local) if local.exists() else {}).get("ANTHROPIC_API_KEY")
    if not key:
        print("ANTHROPIC_API_KEY is not set (.env.local)", file=sys.stderr)
        return 2
    client = anthropic.Anthropic(api_key=key, timeout=600, max_retries=2)

    out = EDGE_CASES / "proposed"
    out.mkdir(parents=True, exist_ok=True)
    spent, written, problems = 0.0, 0, []
    for check in checks:
        cases, invalid, usage = generate(client, check, args.per_check)
        spent += usage["cost_usd"]
        problems += invalid
        print(f"{check}: {len(cases)} valid, {len(invalid)} invalid, {usage['output_tokens']} output tokens, "
              f"{usage['latency_ms'] / 1000:.0f} s, ${usage['cost_usd']:.3f}")
        for case in cases:
            path = out / f"{case.id}.json"
            if path.exists() or (EDGE_CASES / "accepted" / path.name).exists():
                problems.append(f"{case.id}: already exists, not overwritten")
                continue
            path.write_text(json.dumps({
                "generated": {"model": MODEL, "prompt": PROMPT_VERSION,
                              "at": datetime.now(timezone.utc).isoformat(timespec="seconds")},
                "case": case.model_dump(),
            }, indent=1) + "\n")
            written += 1
    for problem in problems:
        print("  skipped:", problem)
    print(f"wrote {written} cases to {out.relative_to(ROOT)}; spent ${spent:.3f}. Review them: --review")
    return 0


if __name__ == "__main__":
    sys.exit(main())
