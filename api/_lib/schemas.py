"""Request bodies. Numbers are strict: a string where a number belongs is a 422, not a coercion."""

from datetime import datetime, timedelta, timezone
from typing import Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator

WaterSource = Literal["piped_home", "public_tap", "borehole", "vendor", "river"]
# A phone clock running ahead is evidence (clock_skew), not a reason to drop the interview; more than a
# day ahead is a broken clock or a forged request.
MAX_FUTURE = timedelta(days=1)


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
    voice_note_path: str | None = Field(default=None, max_length=300, pattern=r"^[\w./-]+$",
                                        description="Audio already uploaded to the voice-notes bucket; transcribed "
                                                    "when there is no transcript")
    source: Literal["simulator", "live"]
    device_synced_at: AwareDatetime | None = Field(
        default=None, description="The phone's own clock when it sent this request; clock_skew compares it with "
                                  "the server's")

    @field_validator("captured_at", "device_synced_at")
    @classmethod
    def _not_in_the_future(cls, value: datetime | None) -> datetime | None:
        if value is not None and value > datetime.now(timezone.utc) + MAX_FUTURE:
            raise ValueError("more than a day in the future")
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

    run_id: UUID = Field(description="The current demo run, from /demo/status or /demo/reset")
    count: int | None = Field(default=None, ge=1, le=50, strict=True,
                              description="How many pending live-day submissions to send (default 1, or 50 with until)")
    until_field_time: AwareDatetime | None = Field(default=None,
                                                   description="Send what phones had synced by this field time")


class CollectTokenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ttl_seconds: int = Field(default=1800, ge=1, le=1800, strict=True, description="Lifetime; at most 30 minutes")


class CollectUploadIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: str = Field(min_length=6, max_length=80)
    client_submission_id: str = Field(min_length=6, max_length=80)
    content_type: str = Field(min_length=5, max_length=80, examples=["audio/webm;codecs=opus", "audio/mp4"])
