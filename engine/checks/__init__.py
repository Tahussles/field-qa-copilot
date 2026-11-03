"""The checks, in the order they are run and stored.

Each module exposes KEY and check(target, context) -> CheckResult.
"""

from . import (burst, clock_skew, copied_text, off_hours, outside_area, same_spot, shared_device, straight_lining,
               too_fast, voice_vs_form)

CHECKS = (too_fast, same_spot, copied_text, straight_lining, voice_vs_form, off_hours, shared_device, burst,
          outside_area, clock_skew)
CHECK_KEYS = tuple(module.KEY for module in CHECKS)
