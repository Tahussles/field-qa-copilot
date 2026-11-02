"""Check the model ids the AI layer uses against the providers' own model lists.

    uv run scripts/ai_models.py

Lists Anthropic's current Haiku and Sonnet models (GET /v1/models) and checks
JUDGE_MODEL and BRIEF_MODEL are among them; checks the ElevenLabs text-to-speech
model and voice exist. Prints ids only, never keys.
"""

import sys
from pathlib import Path

import anthropic
import httpx

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api._lib.ai import BRIEF_MODEL, ELEVENLABS, JUDGE_MODEL, SCRIBE_MODEL, TTS_MODEL, TTS_VOICE  # noqa: E402
from api._lib.postgrest import load_env  # noqa: E402


def main() -> int:
    env = load_env(ROOT / ".env.local")
    problems = []
    if env.get("ANTHROPIC_API_KEY"):
        try:
            ids = [m.id for m in anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"]).models.list()]
        except anthropic.APIStatusError as error:
            ids = []
            problems.append(f"Anthropic rejected the key: {error.status_code} {error.body.get('error', {}).get('message')}")
        if ids:
            print("Anthropic models:", ", ".join(i for i in ids if "haiku" in i or "sonnet" in i))
        for wanted in (JUDGE_MODEL, BRIEF_MODEL) if ids else ():
            print(f"  {wanted}: {'listed' if wanted in ids else 'NOT LISTED'}")
            if wanted not in ids:
                problems.append(wanted)
    else:
        problems.append("ANTHROPIC_API_KEY is not set")
    if env.get("ELEVENLABS_API_KEY"):
        headers = {"xi-api-key": env["ELEVENLABS_API_KEY"]}
        listed = httpx.get(f"{ELEVENLABS}/models", headers=headers, timeout=20)
        if listed.is_error:
            print(f"ElevenLabs /models: HTTP {listed.status_code} {listed.text[:160]}")
        models = [m["model_id"] for m in listed.json()] if listed.is_success else []
        print(f"ElevenLabs TTS {TTS_MODEL}: {'listed' if TTS_MODEL in models else 'NOT LISTED'} "
              f"(speech to text uses {SCRIBE_MODEL})")
        voice = httpx.get(f"{ELEVENLABS}/voices/{TTS_VOICE}", headers=headers, timeout=20)
        print(f"ElevenLabs voice {TTS_VOICE}: {voice.json().get('name') if voice.is_success else voice.status_code}")
        if TTS_MODEL not in models or not voice.is_success:
            problems.append("ElevenLabs model or voice")
    else:
        problems.append("ELEVENLABS_API_KEY is not set")
    for problem in problems:
        print("problem:", problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
