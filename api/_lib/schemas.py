"""Request bodies. Numbers are strict: a string where a number belongs is a 422, not a coercion."""

from datetime import datetime, timedelta, timezone
from typing import Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator

WaterSource = Literal["piped_home", "public_tap", "borehole", "vendor", "river"]
MAX_CLOCK_SKEW = timedelta(minutes=5)


class Answers(BaseModel):
    model_config = ConfigDict(extra="forbid")

    water_source: WaterSource
    satisfaction: list[int] = Field(min_length=8, max_length=8, description="8 answers, each 1 to 5")
    open_text: str = Field(default="", max_length=4000)

    @field_validator("satisfaction")
    @classmethod
    def _one_to_five(cls, values: list[int]) -> list[int]:
        if any(isinstance(v, bool) or not 1 <= v <= 5 for v in values):
            raise ValueError("each satisfaction answer must be an integer from 1 to 5")
        return values


class SubmissionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    contributor_code: str = Field(min_length=1, max_length=16, examples=["E07"])
    device_id: str = Field(min_length=1, max_length=128)
    client_submission_id: str = Field(min_length=8, max_length=128,
                                      description="Generated on the phone; retries reuse it")
    captured_at: AwareDatetime = Field(description="When the phone finished the form, with a UTC offset")
    duration_sec: int = Field(ge=0, le=86_400, strict=True)
    lat: float = Field(ge=-90, le=90, strict=True)
    lng: float = Field(ge=-180, le=180, strict=True)
    gps_accuracy_m: float | None = Field(default=None, ge=0, le=100_000, strict=True)
    answers: Answers
    voice_transcript: str | None = Field(default=None, max_length=4000)
    source: Literal["simulator", "live"]

    @field_validator("captured_at")
    @classmethod
    def _not_in_the_future(cls, value: datetime) -> datetime:
        if value > datetime.now(timezone.utc) + MAX_CLOCK_SKEW:
            raise ValueError("captured_at is in the future")
        return value


class ReviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    submission_id: UUID
    decision: Literal["approve", "backcheck", "reject"]
    note: str | None = Field(default=None, max_length=2000)
    reviewer: str | None = Field(default=None, max_length=100)


class EvaluateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    params: dict[str, Any] = Field(default_factory=dict, examples=[{"weights": {"same_spot": 3}, "review_threshold": 2.5}],
                                   description="Overrides merged over the project's check_config")
    sweep: bool = Field(default=False, description="Also return precision/recall/flagged for thresholds 1.0 to 8.0")


class DemoStepIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    count: int | None = Field(default=None, ge=1, le=50, strict=True,
                              description="How many pending live-day submissions to send (default 1, or 50 with until)")
    until_field_time: AwareDatetime | None = Field(default=None,
                                                   description="Send what phones had synced by this field time")
