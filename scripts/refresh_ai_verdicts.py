"""Refresh the recorded model verdicts that hard mode (and CI) score from, with real model calls.

    uv run scripts/refresh_ai_verdicts.py --estimate   # what is missing or stale, and what refreshing costs
    uv run scripts/refresh_ai_verdicts.py              # make those calls, rewrite data/fixtures/ai_verdicts/
    uv run scripts/refresh_ai_verdicts.py --retry-failed   # also re-ask calls whose recorded answer was a failure

Only calls that are missing (new inputs) or stale (another prompt version or
model, or a verdict that fails today's validation) are made, with the same
prompts, validation and retries as production (api/_lib/ai.py). It estimates
the cost first and stops above --max-usd (default $5) unless --yes. Entries no
current call needs are dropped, so the files hold exactly what CI scores from.
Commit the rewritten files: CI fails until they match the code.
"""

import argparse
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api._lib.ai import JUDGE_MODEL, PROMPT_VERSION, AIUnavailable, LiveProvider, token_cost  # noqa: E402
from api._lib.postgrest import load_env  # noqa: E402
from engine import Params  # noqa: E402
from scripts.evaluate import hard_waves, load_recorded, recorded_status, write_recorded  # noqa: E402

WORKERS = 6
# Estimated tokens per call (input, output incl. thinking at low effort), for the cost guard.
EST_TOKENS = {"consistency": (800, 350), "paraphrase": (450, 200)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--estimate", action="store_true", help="count and price the calls; make none")
    parser.add_argument("--retry-failed", action="store_true", help="re-ask calls recorded as failures")
    parser.add_argument("--max-usd", type=float, default=5.0)
    parser.add_argument("--yes", action="store_true", help="spend even above --max-usd")
    args = parser.parse_args()

    waves = hard_waves(Params.from_config({}))
    plan = {}
    for seed, (_, calls) in waves.items():
        entries = load_recorded(seed)
        status = recorded_status(calls, entries)
        failed = [c for c in calls if "error" in status["found"].get(c["key"], {})] if args.retry_failed else []
        todo = {c["key"]: c for c in status["missing"] + status["stale"] + failed}
        plan[seed] = (calls, status["found"], list(todo.values()))
        print(f"seed {seed}: {len(calls)} calls, {len(status['found'])} recorded, {len(status['missing'])} missing, "
              f"{len(status['stale'])} stale, {len(failed)} failed to retry")
    unique = {c["key"]: c for _, _, todo in plan.values() for c in todo}
    estimate = sum(token_cost(JUDGE_MODEL, *EST_TOKENS[c["kind"]]) for c in unique.values())
    print(f"{len(unique)} calls to make with {JUDGE_MODEL}, prompt {PROMPT_VERSION}: estimated ${estimate:.2f}")
    if args.estimate:
        return 0
    if estimate > args.max_usd and not args.yes:
        print(f"stopping: the estimate is over ${args.max_usd:.2f}; re-run with --yes to spend it", file=sys.stderr)
        return 3

    results: dict[str, dict] = {}
    if unique:
        env = load_env(ROOT / ".env.local") if (ROOT / ".env.local").exists() else {}
        provider = LiveProvider(env.get("ANTHROPIC_API_KEY") or None, None)
        if not provider.can["judge"]:
            print("ANTHROPIC_API_KEY is not set (.env.local)", file=sys.stderr)
            return 2
        lock, started = threading.Lock(), time.monotonic()

        def judge(call: dict) -> None:
            base = {"kind": call["kind"], "input_hash": call["input_hash"], "prompt": PROMPT_VERSION}
            try:
                if call["kind"] == "consistency":
                    verdict, usage = provider.judge_consistency(*call["args"])
                else:
                    verdict, usage = provider.judge_paraphrase(*call["args"])
                entry = {**base, "verdict": verdict.model_dump(), "model": usage.model,
                         "latency_ms": usage.latency_ms, "cost_usd": usage.cost_usd}
            except AIUnavailable as error:
                entry = {**base, "error": str(error), "model": JUDGE_MODEL,
                         "cost_usd": error.usage.cost_usd if error.usage else 0.0}
            with lock:
                results[call["key"]] = entry
                if len(results) % 100 == 0:
                    print(f"  {len(results)}/{len(unique)} calls, {time.monotonic() - started:.0f} s")

        with ThreadPoolExecutor(WORKERS) as pool:
            list(pool.map(judge, unique.values()))

    for seed, (calls, found, _) in plan.items():
        wanted = {c["key"] for c in calls}
        write_recorded(seed, {k: v for k, v in {**found, **results}.items() if k in wanted})
    spent = sum(e.get("cost_usd") or 0 for e in results.values())
    failed = sum("error" in e for e in results.values())
    print(f"made {len(results)} calls ({failed} failed after retries), spent ${spent:.4f}; "
          f"rewrote data/fixtures/ai_verdicts/ (commit it)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
