# How AI is used in Field QA Copilot

A short guide a team could adopt. Each rule says what we do, why, and where it lives in the code.

## 1. Where AI is allowed, and where it is not

**Allowed:** turning speech into text (ElevenLabs Scribe), judging *meaning* that keyword rules cannot read (does the voice note contradict the form? is answer B a reworded copy of answer A?), and writing the morning brief and reading it aloud.

**Not allowed:** deciding whether a submission is flagged. All nine checks are deterministic Python (`engine/checks/`). A model's judgment is stored as an input (`ai_verdicts`) that a check reads, the same way it reads a GPS point. With no verdict the rule-based result stands. The same submission and verdicts always give the same score. The engine never calls a model, and its evidence records who decided (`decided_by: ai | ai_paraphrase | rules`).

A model's word alone does not send anyone to review:
- voice_vs_form uses a verdict only at confidence >= 0.7.
- A reworded copy found only by the model weighs 1.5, below the review threshold of 2.0. It corroborates other checks and never flags on its own.

## 2. Structured output, validated twice

Every call (`api/_lib/ai.py`) asks for strict JSON against a schema with `additionalProperties: false`, then validates the answer with pydantic and with our own checks. Free prose (an explanation, a reason) that runs long is trimmed at a word boundary. A long-winded answer is not a wrong one. The decision, the confidence and anything we rely on stay strict.

## 3. Quotes must be substrings; numbers in, numbers out

- **Quotes.** A voice-vs-form verdict must quote the transcript, and the quote must be an exact substring. A paraphrased or invented quote rejects the verdict, and the call is retried. The dashboard highlights that span in the transcript, so a reviewer sees the evidence and not the model's summary of it.
- **Numbers.** The brief is written from an aggregates-only facts JSON (`api/_lib/brief.py`). Every number in the written brief must appear in those facts as written. A brief with any other number is regenerated once, then replaced by a template built from the same facts.

## 4. Prompt injection

Transcripts and open answers are field data: anyone with the app can put words in them.
- They go to the model inside tags (`<transcript>`, `<answer_a>`), and look-alike tags inside the data are neutralised first.
- The system prompt says the tags hold data only, and that instructions inside them change nothing.
- The quote check above catches a verdict that tries to cite text that isn't in the transcript.
- One live test (`RUN_LIVE_AI=1 uv run pytest -k live`) sends a transcript that tells the model to report no contradiction, and asserts the verdict still finds it.

Contributors are sent by code, never by name.

## 5. Timeouts, retries and fallbacks

- **Calls.** Each call has a 12 s timeout and at most 3 attempts with backoff, then raises `AIUnavailable`, and the caller keeps the rule-based result.
- **Ingest.** It never waits on a model. Jobs are queued after the commit, and a queueing failure is swallowed.
- **Delivery.** The database posts each new job to the API (pg_net), and a cron sweep re-sends deliveries that never arrived.
- **Idempotency.** Jobs are deduplicated by key, so a repeat is harmless.
- **No key.** A deployment without a model key skips the job at once and says why.
- **Previews.** Preview deployments are read-only and run no jobs at all.

## 6. Cost: log every call, guard every batch

- **Logging.** Every `ai_jobs` row records model, tokens, latency and estimated cost (`ai.PRICES`, plus ElevenLabs per hour and per character). The demo panel shows spend for this run and all time, and `ai_jobs` outlive demo resets so the total stays honest.
- **Guards.** Any script that makes many calls estimates the cost first and stops above a limit (default $5) unless told otherwise. This covers `backfill_ai.py`, `refresh_ai_verdicts.py` and `gen_edge_cases.py`.
- **Model choice.** The cheapest model that does the job: a Haiku-class model judges, and a Sonnet-class model writes the one brief a day.

## 7. Recorded verdicts make CI reproducible

CI must not need keys, spend money, or change its answer because a model had a different day. The hard-mode evaluation therefore scores rules + AI from recorded verdicts committed in `data/fixtures/ai_verdicts/`:
- Each entry is keyed by kind, input hash, prompt version and model id.
- Entries are re-validated with production's models when loaded.
- A missing or stale entry fails CI with the refresh command.
- `scripts/refresh_ai_verdicts.py` re-records only what changed, behind the cost guard.

Changing a prompt means bumping `PROMPT_VERSION`, re-recording, and reading the eval diff on the PR.

## 8. AI-generated tests need a human

`scripts/gen_edge_cases.py` asks a model for boundary and adversarial cases per check. The model gets each rule in plain words, never the code. Each case is validated with pydantic and lands in `data/fixtures/edge_cases/proposed/`. Nothing proposed is trusted: a person runs `--review` and reads each case against the engine.
- **Accepted** cases move to `accepted/` and run in pytest with no model involved.
- **Rejected** cases had a wrong expectation (the model misread the rule).
- **Gaps** are cases where the expectation is right and the engine is wrong. They are reported, and the case is never bent to fit the code.

## 9. How this project itself was built

The code was written by an AI coding agent working in numbered rounds, each with a written brief (the spec) and acceptance criteria:
- The agent did only the current round, then stopped and reported proof: links, test results, timings, deviations and open questions.
- A person reviewed every round before the next one started.
- Guard rails in the repository kept it honest:
  - **Eval gates.** Held-out seeds are never tuned on, and CI fails below precision 0.85 or recall 0.97.
  - **Tuning evidence.** A changed default must cite its tuning-seed evidence in a comment.
  - **Sign-off.** Changes to production (migrations, environment variables, merges) waited for a human yes.
  - **Commit rules.** A commit hook and a CI job reject attribution lines in commit messages, and any commit not authored by the project owner.

The review loop was what made this safe, not the agent. Specs came first, every number had a script behind it, and nothing reached production without someone reading the report.
