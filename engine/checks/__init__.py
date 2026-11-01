"""The checks, in the order they are run and stored.

Each module exposes KEY and check(target, context) -> CheckResult.
"""

from . import burst, copied_text, off_hours, same_spot, shared_device, straight_lining, too_fast, voice_vs_form

CHECKS = (too_fast, same_spot, copied_text, straight_lining, voice_vs_form, off_hours, shared_device, burst)
CHECK_KEYS = tuple(module.KEY for module in CHECKS)
