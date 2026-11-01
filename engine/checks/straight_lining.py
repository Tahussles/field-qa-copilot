"""straight_lining: all 8 satisfaction answers are identical."""

from ..model import CheckResult, Context, Submission

KEY = "straight_lining"
ITEMS = 8


def check(target: Submission, ctx: Context) -> CheckResult:
    weight = ctx.params.weights[KEY]
    values = list(target.answers.get("satisfaction") or [])
    if len(values) != ITEMS:
        return CheckResult(KEY, False, weight, {"values": values, "missing": f"expected {ITEMS} answers"})
    return CheckResult(KEY, len(set(values)) == 1, weight, {
        "values": values,
        "distinct_values": len(set(values)),
    })
