# Edge case review: batch 1 (prompt edge-v1, 45 cases, $1.50)

Proposed by `scripts/gen_edge_cases.py` (5 per check). Each case was run through the engine (`--review`) and read against what the check is *for*, not only against its rule as written. All 45 agreed with the engine, because the generator is given the rules, so agreement alone proves little. The real review question was whether the rule itself gives the right answer.

**Accepted: 39** (moved to `accepted/`, run by `tests/test_edge_cases.py`).
**Rejected (wrong expectation): 0.** No case contradicted the rules it was given, and every distance, time difference and word overlap the cases rely on checked out (for example the Jaccard values 0.8, 0.778, 1.0 and 1.0 in the copied_text cases).
**Real gaps: 6 cases** (left in `proposed/`), plus one more found while reviewing. In each one the case follows the rule, but the rule gives the wrong answer for what the check is meant to catch. They are listed below with the expectation they *should* have. Engine logic was not changed in this round.

## Accepted

| check | cases |
|---|---|
| burst | adversarial-mixed-offsets, enum-60min-plus-1s, enum-exact-60min-inclusive, participant-centered-window, participant-four-is-not-enough |
| copied_text | both-empty-silent, earlier-target-via-shared-device, exactly-0-8-fires, just-below-0-8-silent, stopword-and-case-rewording |
| off_hours | 205959-silent, exact-0600-silent, exact-2100-fires, utc-0300-is-0600-local, utc-offset-disguise |
| same_spot | chain-walk-evasion, diagonal-just-outside-radius, local-day-not-utc-date, self-not-counted, two-neighbours-inside-radius |
| shared_device | contributor-shares-elsewhere, one-contributor-many-submissions, other-contributor-later, similar-id-not-same, single-slip-months-apart |
| straight_lining | all-threes-middle-value, different-value-each-form, first-answer-differs, last-answer-differs |
| too_fast | enumerator-exactly-twelve-minutes, enumerator-one-second-short, enumerator-padded-past-participant-minimum, participant-exactly-three-minutes, participant-one-second-short |
| voice_vs_form | earliest-keyword-beats-form-echo, keyword-inside-word-does-not-match, prefix-match-pipeline |
| outside_area | other-project-area, sw-corner-just-inside |

## Real gaps

1. **outside_area has no GPS tolerance.** `outside-area-east-edge-lat-in-band` and `outside-area-north-edge-just-outside` are 5.6 m past the boundary, and `outside-area-participant-across-shared-corner` is 7.9 m past it. All three fire, which is inside ordinary phone GPS error. The engine never reads `gps_accuracy_m`, and outside_area's weight (2.0) equals the review threshold, so one noisy fix at a boundary household sends a genuine interview to review on its own. *Should:* not fire within the reported accuracy (or a floor such as 20 m) of the boundary, or fire there below the review weight.
2. **straight_lining is beaten by alternating answers.** `straight-lining-alternating-four-five` (5, 4, 5, 4, …) stays silent because the rule needs all 8 answers identical. A fabricator who knows the rule moves one step. *Should:* fire on at most 2 distinct values in a strict alternation, or on very low variance. This needs tuning-seed evidence first, since genuine respondents do answer 4s and 5s.
3. **voice_vs_form treats "buy from" as a vendor even at a kiosk.** `voice-vs-form-buy-from-precedes-kiosk`: "We buy from the kiosk near the chief's office" with the form at public_tap fires as a contradiction. But kiosks sell water by the jerrycan, and the form's own label is "public tap or kiosk". This is a false alarm on a consistent answer. *Should not fire.* Matching the source noun ("kiosk") ahead of the verb phrase ("buy from") would fix it.
4. **voice_vs_form misses a tap that is not a listed phrase.** `voice-vs-form-bare-tap-is-not-a-keyword`: "We fetch from a tap down the road and pay five shillings per jerrycan" with the form at piped_home stays silent, because a bare "tap" is in no keyword list. A person reads it as a clear contradiction. *Should fire* (public_tap). The model verdict catches this in production when one exists; the rule alone misses it.
5. **voice_vs_form's prefix matching misfires** (found while reviewing `prefix-match-pipeline`; no generated case covers it yet). Keywords match at the start of any word, so "We grow pumpkins and fetch from the river" reads as borehole ("pump"), and "The lakeside road is far; we use the borehole" reads as river ("lake"). Both are false contradictions. *Should:* match whole words with plural endings ("pipes", "pumps") and list compounds like "pipeline" explicitly. The accepted `prefix-match-pipeline` case keeps passing under that fix.

## What to change in the next batch

The generator saw the rules, so it tested the rules' edges well and the rules' intent hardly at all. Next time, also ask for cases written from the purpose of each check ("what would a careful supervisor expect here?") without the threshold text. That is where gaps 3 to 5 came from.

# Round 9b: the gaps closed (engine 0.5.0)

All six gap cases are now accepted, with their expectations corrected to what each check is for (each file says so in `review`). The bare-tap case carries its recorded model verdict and is caught by the model, not by a new keyword. 19 hand-written cases pin the fixes and the new clock_skew check. `accepted/` now holds 64 cases.

Run against engine 0.4.0, 15 of the 25 new or corrected cases fail, and all 25 pass on 0.5.0. The other 10 are guards that pass on both: silent cases, and the case the model decides.

| fix | fails on 0.4.0, passes on 0.5.0 | guards (pass on both) |
|---|---|---|
| outside_area: tolerance max(gps_accuracy_m, 15 m); 1.5 within 1 km, 2.0 beyond | east-edge-lat-in-band, north-edge-just-outside, participant-across-shared-corner, 30m-out-accuracy-8m-near-band, 30m-out-accuracy-40m-within-error | 2km-out-far-band-flags, 500m-out-with-night-work-flags |
| straight_lining: strict two-value zig-zag | alternating-four-five, zigzag-one-three | near-zigzag-silent, within-one-point-silent |
| voice_vs_form: whole words; "buy from" only when no source is named | buy-from-precedes-kiosk, buy-from-the-kiosk-on-a-vendor-form, lakeside-is-not-a-lake, pumpkins-are-not-a-pump | kiosks-plural-counts, buy-from-the-handcart-man, buy-from-them-falls-back-to-vendor |
| meaning left to the model (no rule change) | none | bare-tap-caught-by-the-model |
| clock_skew (new) | 3h-behind-at-sync, 6-minutes-ahead-fires, capture-after-receipt, set-back-with-night-work-flags | 4-minutes-ahead-silent, late-sync-right-clock-silent |
