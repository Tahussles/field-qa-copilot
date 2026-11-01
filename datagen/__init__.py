"""Seeded synthetic survey wave with planted fraud, for development and evaluation.

Kept separate from engine/: detection code must never import this package or
read the ground truth it produces.
"""

from .wave import Wave, build_wave, db_rows

__all__ = ["Wave", "build_wave", "db_rows"]
