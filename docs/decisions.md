# Key design decisions

Ten decisions that shaped Field QA Copilot, each with the reason it was made. The numbers come from `scripts/evaluate.py` and production timing runs. The commit history shows how each one arrived.

## 1. Checks are code; a model is an input, not a judge

A fabricated form is a claim against a person, so the reason it was flagged must be explainable, repeatable and cheap to re-run. Every check is a deterministic Python function that stores `fired`, `weight` and human-readable evidence, stamped with the engine version. Models do the one thing rules cannot: read meaning (a voice note saying "the pipe has been dry since March, we buy from the handcart man" contradicts *piped into the home*). Their answers are stored as verdicts that the voice and copy checks read. With no verdict, the keyword rule decides, so a model outage changes nothing but recall.

## 2. same_spot needs corroboration

Enumerators interview neighbouring households, so several genuine interviews within 50 m on one day are normal in dense compounds. At its spec weight of 3.0, same_spot alone flagged them: on the tuning seeds, precision was 58.4%. At 1.5, below the review threshold of 2.0, it flags only together with another signal (a burst, a too-fast interview, night work). Precision rose to 87.7% while recall went from 100% to 99.5%. The weight sits next to that evidence in `engine/config.py`.

## 3. A copy only the model sees weighs 1.5

The model finds reworded copies the word-overlap rule misses. But "the queue at the kiosk is long" is a stock phrase in one neighbourhood, not proof of a copy. A copy found only by the model therefore weighs 1.5: corroboration, never a flag on its own. The hard-mode tuning seeds (211–212) could not tell weights 1.0 to 3.0 apart (91.2% / 86.3% at every value), so the value is a policy choice, recorded with its sweep in `data/eval/hard.json`.

## 4. Two-call ingest with fenced leases

A new submission can change other submissions' scores: a shared device flips every account that used it. Scoring must read and write a consistent group without a database transaction spanning Python. `ingest_begin` takes 15-second leases on every contributor and device the arrival can affect, inserts the submission idempotently and returns the scoring context. Python scores it. `ingest_commit` writes the results only if the leases still hold, then releases them. A commit after its lease expired writes nothing. Going from eight calls to two took production p50 from 596 ms to 188 ms.

## 5. Retries heal instead of failing

Phones retry, because networks drop and apps get killed mid-sync. The phone generates `client_submission_id`, so a retry returns the stored record. If an earlier attempt stored the row but died before scoring, or scored it with an older engine, the retry heals it and its affected group through the same leased path. No retry, crash or deploy leaves a submission permanently unscored.

## 6. Tune on some seeds, report on others

Synthetic data with planted fraud makes precision and recall measurable, and also easy to overfit. Defaults may be tuned on seeds 1–5 only. Seeds 101–110 are held out for reporting and the CI gate (precision >= 0.85, recall >= 0.97). Hard mode, which rewrites three fraud actors to evade the rules, follows the same split: it tunes on seeds 211–212 and reports on 201–202. A changed default must cite its tuning-seed evidence in a comment beside it.

## 7. The demo runs on a field clock

The demo replays one field day (Oct 31, Kisumu) at any hour, from Toronto. `projects.as_of` is the project's "now" and `day_pin` keeps "today" on the replayed day. A phone used during the demo would otherwise stamp its interviews with the real time: night in Kisumu fires off_hours, and the rows fall outside the pinned day. While `as_of` is set, the API maps a phone's time onto the field clock: `as_of` plus the real time since it was last set. The phone's own time is kept in `device_captured_at`. Without a demo clock, the phone's time is used as is.

## 8. Model work never blocks ingest

The rules score a submission in about 200 ms; transcription and judging take seconds and sometimes fail. So ingest commits the rules' result first and queues model jobs after. The database posts each new job to the API (pg_net). A cron sweep re-sends the deliveries that never arrived, and the dedupe keys make any repeat harmless. When a verdict lands, the submission is rescored through the same leased path, and Realtime updates the screen. The phone shows the rules' result at 1.9 s and the model's verdict at about 6.7 s.

## 9. CI replays recorded verdicts

Scoring rules + AI in CI with live calls would need keys, cost money on every push and give a different answer whenever the model did. The hard-mode verdicts are recorded once, committed and replayed. Each is keyed by input hash, prompt version and model id, and re-validated on load. A changed prompt or model fails CI until the verdicts are re-recorded on purpose, behind a cost guard. The PR's eval comment then shows what the change did.

## 10. Previews read, production writes

Preview deployments share production's database, so a preview that could write would put test data into the demo and spend model money on unreviewed code. `WRITES_ENABLED` is true on Production only: on a preview, every credentialed route returns 403, no brief is queued, and a banner says it is read-only. The phone side is offline-first for the same reason in reverse: the field is the unreliable part. Every interview, audio included, is saved to an IndexedDB outbox before any network call, and syncs when it can.
