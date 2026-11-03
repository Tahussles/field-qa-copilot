"""Recorded model verdicts: CI scores rules + AI from them, so they must say clearly when they no longer fit."""

from scripts import evaluate as ev

TRANSCRIPT = "The pipe at home has been dry since March, so we buy from the handcart man."


def consistency_call(prompt="v2", model="claude-haiku-5-5"):
    args = ("piped_home", "", TRANSCRIPT)
    digest = ev.input_hash("consistency", args)
    return {"kind": "consistency", "args": args, "input_hash": digest, "submission_id": "s1",
            "key": f"consistency:{digest}:{prompt}:{model}"}


def entry(call, prompt="v2", model="claude-haiku-5-5", **verdict):
    return {"kind": call["kind"], "input_hash": call["input_hash"], "prompt": prompt, "model": model,
            "latency_ms": 900, "cost_usd": 0.0001,
            "verdict": {"contradiction": True, "confidence": 0.9, "form_says": "piped", "voice_says": "vendor",
                        "quote": "we buy from the handcart man", "explanation": "The pipe is dry.", **verdict}}


def test_a_matching_entry_is_used_and_an_absent_one_is_missing():
    call = consistency_call()
    status = ev.recorded_status([call], {call["key"]: entry(call)})
    assert list(status["found"]) == [call["key"]] and not status["missing"] and not status["stale"]
    assert ev.recorded_status([call], {})["missing"] == [call]


def test_a_new_prompt_version_or_model_makes_the_old_entry_stale():
    old = consistency_call(prompt="v2")
    for new in (consistency_call(prompt="v3"), consistency_call(model="claude-haiku-6")):
        status = ev.recorded_status([new], {old["key"]: entry(old)})
        assert status["stale"] == [new] and not status["found"]


def test_a_recorded_verdict_that_fails_todays_validation_is_stale():
    call = consistency_call()
    invented = entry(call, quote="we buy from the vendor at the market")  # not a span of the transcript
    assert ev.recorded_status([call], {call["key"]: invented})["stale"] == [call]


def test_verdicts_from_the_recording_go_through_the_same_models_as_production():
    call = consistency_call()
    long = entry(call, explanation="The household explains at length " * 30)
    verdicts = ev.hard_verdicts([call], {call["key"]: long})
    (verdict,) = verdicts["s1"]
    assert verdict.kind == "voice_vs_form" and len(verdict.data["explanation"]) <= 300  # trimmed, as live


def test_recorded_files_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(ev, "RECORDED", tmp_path)
    call = consistency_call()
    ev.write_recorded(7, {call["key"]: entry(call)})
    assert ev.load_recorded(7) == {call["key"]: entry(call)}
    assert ev.load_recorded(8) == {}
