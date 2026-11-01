"""Evaluate the detection engine against synthetic ground truth.

This is the only code allowed to read the synthetic_truth table. It joins the
stored scores for one engine_version with synthetic_truth and reports
precision, recall and per-fraud-type detection rates, plus how often each
check fired on clean versus fabricated submissions.
"""
