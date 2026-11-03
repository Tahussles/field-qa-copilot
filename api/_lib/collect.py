"""Access for the phone collect page (/collect): a short signed token instead of the passcode.

The token is `<expiry, hex seconds>.<demo run, 12 hex>.<signature>`: an HMAC over
the first two parts with a secret derived from the service key. It expires
(30 minutes by default) and a demo reset revokes it, because the run changes.
It only lets a phone do what a phone does: send live submissions and upload
their voice notes. Everything else still needs the passcode.
"""

import base64
import hashlib
import hmac
import re
import time

TTL_SECONDS = 30 * 60
VOICE_BUCKET = "voice-notes"
AUDIO_TYPES = {  # what MediaRecorder produces (Chrome webm/opus, iOS Safari mp4/aac) and test fixtures
    "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/aac": "aac", "audio/x-m4a": "m4a",
    "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
}
_SAFE = re.compile(r"^[A-Za-z0-9_-]{6,80}$")


class Refused(Exception):
    """Why a token was not accepted (expired, revoked by a reset, or not ours)."""


def secret(service_key: str) -> bytes:
    return hmac.new(service_key.encode(), b"field-qa-copilot/collect-token", hashlib.sha256).digest()


def _sign(key: bytes, payload: str) -> str:
    digest = hmac.new(key, payload.encode(), hashlib.sha256).digest()[:16]
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def _run(run_id: str) -> str:
    return run_id.replace("-", "")[:12]


def mint(key: bytes, run_id: str, ttl_seconds: int = TTL_SECONDS, now: float | None = None) -> tuple[str, int]:
    expires = int((now or time.time()) + ttl_seconds)
    payload = f"{expires:x}.{_run(run_id)}"
    return f"{payload}.{_sign(key, payload)}", expires


def verify(key: bytes, token: str, run_id: str | None, now: float | None = None) -> int:
    """The token's expiry (unix seconds) if it is good, else Refused with the reason."""
    parts = (token or "").split(".")
    if len(parts) != 3:
        raise Refused("not a collect token")
    payload = f"{parts[0]}.{parts[1]}"
    if not hmac.compare_digest(parts[2], _sign(key, payload)):
        raise Refused("not a collect token")
    if not run_id or parts[1] != _run(run_id):
        raise Refused("this QR code was revoked by a demo reset; scan the new one")
    expires = int(parts[0], 16)
    if expires < (now or time.time()):
        raise Refused("this QR code has expired; ask for a new one")
    return expires


def voice_path(device_id: str, client_submission_id: str, content_type: str) -> str:
    """Where a phone's voice note goes: live/<device>/<client id>.<ext> (a retry reuses the path)."""
    base = content_type.split(";")[0].strip().lower()
    if base not in AUDIO_TYPES:
        raise ValueError(f"unsupported audio type {content_type}")
    if not _SAFE.match(device_id) or not _SAFE.match(client_submission_id):
        raise ValueError("device_id and client_submission_id must be 6-80 letters, digits, - or _")
    return f"live/{device_id}/{client_submission_id}.{AUDIO_TYPES[base]}"
