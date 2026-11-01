"""shared_device: the device has submitted for two or more contributors in the project."""

from ..model import CheckResult, Context, Submission

KEY = "shared_device"


def check(target: Submission, ctx: Context) -> CheckResult:
    params = ctx.params
    weight = params.weights[KEY]
    if not target.device_id:
        return CheckResult(KEY, False, weight, {"missing": "device_id"})
    accounts = [
        {"contributor_id": c.id, "code": c.code, "kind": c.kind, "submissions": count}
        for c, count in ctx.device_accounts
    ]
    return CheckResult(KEY, len(accounts) >= params.shared_device_min_accounts, weight, {
        "device_id": target.device_id,
        "account_count": len(accounts),
        "accounts": accounts,
    })
