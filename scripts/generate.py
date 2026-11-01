"""Generate a synthetic project for development and evaluation.

Creates a project with areas, contributors (enumerators and participants) and
submissions with source='synthetic'. A known share of submissions is fabricated
on purpose (for example copy-paste answers, impossible GPS jumps, implausibly
short durations), and the ground truth for each one is written to the
synthetic_truth table.
"""
