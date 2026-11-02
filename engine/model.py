"""Engine inputs and outputs. Plain data, no I/O."""

from dataclasses import dataclass
from datetime import date, datetime, timezone, tzinfo
from typing import Any, Mapping

from .config import Params


def parse_time(value: datetime | str | None) -> datetime | None:
    if value is None or isinstance(value, datetime):
        return value
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp without a timezone: {value}")
    return parsed


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


@dataclass(frozen=True)
class Submission:
    id: str
    contributor_id: str
    device_id: str | None
    captured_at: datetime
    synced_at: datetime | None
    duration_sec: int | None
    lat: float | None
    lng: float | None
    answers: Mapping[str, Any]
    voice_transcript: str | None = None

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "Submission":
        """Build from a submissions row (as stored in Supabase)."""
        return cls(
            id=row["id"],
            contributor_id=row["contributor_id"],
            device_id=row.get("device_id"),
            captured_at=parse_time(row["captured_at"]),
            synced_at=parse_time(row.get("synced_at")),
            duration_sec=row.get("duration_sec"),
            lat=row.get("lat"),
            lng=row.get("lng"),
            answers=row.get("answers") or {},
            voice_transcript=row.get("voice_transcript"),
        )

    def local_date(self, tz: tzinfo) -> date:
        return self.captured_at.astimezone(tz).date()


@dataclass(frozen=True)
class Contributor:
    id: str
    code: str
    kind: str  # 'enumerator' or 'participant'

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "Contributor":
        return cls(id=row["id"], code=row["code"], kind=row["kind"])


@dataclass(frozen=True)
class CheckResult:
    key: str
    fired: bool
    weight: float
    evidence: dict[str, Any]


@dataclass(frozen=True)
class Verdict:
    """A model's judgment, stored (ai_verdicts) and handed to the checks as input.

    Checks never call a model: they read these. With no verdict, the rule-based
    check stands, and the same submissions and verdicts always give the same result.
    """

    kind: str  # 'voice_vs_form' or 'paraphrase'
    model: str
    data: Mapping[str, Any]
    other_id: str | None = None  # paraphrase: the other submission of the pair


@dataclass(frozen=True)
class Context:
    """Everything a check may look at besides the target itself.

    Lists exclude the target and are ordered by (captured_at, id).
    """

    contributor: Contributor
    params: Params
    tz: tzinfo
    same_contributor: tuple[Submission, ...]
    same_contributor_day: tuple[Submission, ...]  # same local date in the project timezone
    same_device: tuple[Submission, ...]  # any contributor
    device_accounts: tuple[tuple[Contributor, int], ...]  # contributors on this device, with submission counts
    verdicts: tuple[Verdict, ...] = ()  # stored AI verdicts about the target
