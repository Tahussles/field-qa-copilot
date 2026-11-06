# Interview pack

Everything here comes from the repository's own numbers: `data/eval/headline.json` (held-out seeds 101–110), `data/eval/hard.json` (hard mode, seeds 201–202), and `data/eval/measurements.json` (production, measured 2026-11-03: 20 ingests and 3 phone interviews). Re-run `uv run scripts/evaluate.py`, `--hard` and `scripts/measure.py` and these move with them. `pnpm preflight` 30 minutes before.

## The 75-second pitch

Poket pays contributors per submission, and that reward model invites fakes: forms filled in at a tea shop, answers copied from yesterday, one phone running five accounts, interviews written at night. Today a researcher finds out weeks later, if at all.

Field QA Copilot checks every interview the moment it syncs. Ten plain, explainable checks score it in under half a second. Each flag shows its evidence: the pile of GPS points, the two copied answers side by side, the sentence in the voice note that contradicts the form. Flagged work lands in a queue where a person approves, rejects or sends a back-check, and the lead researcher gets a morning brief on who to look at first.

AI is an input, never the judge. A model transcribes the voice note and reads meaning the rules can't, and its verdict feeds a rule. If the model is down, the rules still stand.

On data it was never tuned on, it catches 99% of planted fakes, and 89% of what it flags is fake. On a harder wave where the fakers try to dodge the rules, the model lifts recall from 72% to 87%. It runs end to end on production for under a dollar of model spend so far.

## Demo beats (the Script tab: press D, then Script)

| at | beat | what to say |
|---|---|---|
| 0:00 | Landing | "Rewards per submission invite fakes. This replays yesterday's real submissions; orange is flagged." |
| 0:40 | Morning brief | "The researcher's first screen: written from today's numbers, every number checked against them. Listen reads it aloud." |
| 1:30 | E07 hotspot | "E07 logged 18 interviews in one spot. Genuine interviews are spread across homes; this is a tea shop." |
| 2:30 | E07 in the queue | "Evidence per check, a map of the cluster. A approves, B sends a back-check, R rejects; undo is one click. Decisions are a person's, always." |
| 3:40 | Detectors | "Drag the threshold: precision and recall move live, scored against the planted truth. same_spot alone is weak, so it only corroborates." |
| 4:40 | Phone | "Scan this: the phone is offline-first. I'll say the pipe at home has been dry since March, on a piped-home form." The rules answer in about 1.0 s, the transcript in about 3.9 s, and the model's verdict, quoting the sentence, in about 6.5 s. |
| 6:10 | Clock off by 3 h | "Demo controls on the phone: set its clock back 3 hours, like a forger hiding night work. Clock skew and off-hours flag it together." |
| 7:00 | /architecture | "Two database calls with leases per arrival; model work queued after the commit and never awaited; Realtime pushes every change." |
| 8:00 | /pitch | Slide 4 (proof), then what's next. |

Target: 9:00. A recorded run, `data/recordings/demo.mp4`, is the backup if the network fails.

## Numbers cheat sheet

| | | source |
|---|---|---|
| Held-out recall (fakes caught) | **99.3%** (97.9–100% per seed) | headline.json |
| Held-out precision (flags that are fake) | **88.9%** (87.0–90.3%) | headline.json |
| Per held-out wave | 152 flagged, 136 fabricated, 16.8 false alarms | headline.json |
| Hard mode, rules only | precision 86.9%, recall 71.7% | hard.json |
| Hard mode, rules + AI | precision **91.5%**, recall **86.9%** | hard.json |
| Hard mode, night forger with the clock set back 3 h | 6.5 night forms missed per wave without clock_skew, 0 with it | hard.json |
| Ingest, `POST /submissions` from Toronto | p50 **340 ms**, p95 487 ms (276 ms inside the API) | measurements.json |
| Realtime, insert to screen | p50 402 ms (max 576 ms of 4) | measurements.json |
| Phone, from Submit | rules 1.0 s · transcript 3.9 s · verdict 6.5 s (medians of 3) | measurements.json |
| Model latency per call | judge p50 1.36 s (n=3,521), Scribe p50 0.56 s | measurements.json |
| Model spend, all time | **$0.74** for 3,800 jobs | measurements.json |
| Hard-mode verdicts recorded for CI | 6,953 for $1.16, replayed for free | hard.json |
| Demo wave | 1,676 interviews, 126 planted fakes; 138 flagged on production (rules + stored verdicts) | headline.json, verify_wave.py |

## Ten likely questions

1. **Why not let a model decide?** Flags are claims against people, so they must be explainable and repeatable, and they must work when a model is slow or down. The model reads meaning, the rules decide, and the evidence says which.
2. **How do you know the numbers aren't overfit?** Defaults are tuned on seeds 1–5 only. Seeds 101–110 are held out and gate CI at precision ≥ 0.85 and recall ≥ 0.97. Hard mode has its own split (tune on 211–212, report on 201–202).
3. **The data is synthetic. Does that mean anything?** It's the only way to know the truth for every row. Real field data has no labels. Synthetic data with planted fraud, plus a hard mode written to dodge the rules, gives an honest upper bound and a test bed. Real deployment needs reviewer decisions fed back as labels.
4. **What happens offline?** Every interview, audio included, goes to an IndexedDB outbox first and syncs when it can. A retry reuses its client id, so it never double-counts, and one that crashed mid-score is healed.
5. **What if two phones sync at once for the same contributor?** `ingest_begin` leases every contributor and device the arrival can affect, and `ingest_commit` is fenced. A commit after its lease expired writes nothing, and the retry rescores.
6. **What does the AI cost?** Per interview, about $0.0003 to transcribe and $0.0002 to judge. All time on production: $0.74. Every call is logged with its tokens, latency and cost, and batch scripts stop above $5 unless told otherwise.
7. **What about prompt injection in the voice note?** Transcripts go in tags as data, look-alike tags are neutralised, and a verdict's quote must be an exact substring of the transcript or the verdict is rejected. A live test tries an injection.
8. **How does it scale to a real survey?** Ingest is two database calls and pure-Python scoring of the affected group. Model work is queued and runs in parallel. The leases make it correct under concurrency, not just fast.
9. **How was it built?** In reviewed rounds with an AI coding agent. Each round had a spec, tests, eval gates and a report, and a person approved every production change. CI fails if detection gets worse or a commit isn't the author's own (`docs/ai-practices.md`).
10. **What would you build next?** A monotonic clock check (time since boot, sent with every form), reward-gaming checks (submissions bunched under a payout threshold), and a feed into the verification queue reviewers already use.

## Honest limitations

- **Synthetic data.** The truth is known because I planted it. The precision and recall are what the checks achieve on fraud patterns I wrote, so they are an upper bound, not a field result. Real use needs reviewer decisions as labels.
- **The careful curbstoner gets through.** In hard mode E07 walks the tea-shop forms 60 to 120 m apart, 20+ minutes apart, with believable durations. Every one of those 19.5 forms per wave is missed, by rules only and by rules + AI. The meaning checks can't see GPS or timing. Catching it needs back-checks or a route-plausibility check (distance walked against time between interviews).
- **The clock reset before sync.** clock_skew compares the phone's clock with the server's at sync. A forger who sets the clock back, fills forms, and puts it right before syncing leaves no skew. Only a capture time after receipt, or a monotonic clock, would show it.
- **outside_area and clock_skew are measured only on fixtures and hard mode.** The normal synthetic waves never place a point outside its area and carry no phone clock. Their thresholds rest on the edge-case fixtures and a GPS-error model, and clock_skew on the hard-mode night forger.
- **Model verdicts vary.** CI replays recorded verdicts, so its numbers are stable. A live verdict can differ from the recording, and that's why a verdict only counts at confidence ≥ 0.7, a model-only copy weighs 1.5, and the rules stand on their own.
