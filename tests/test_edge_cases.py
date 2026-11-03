"""Reviewed edge cases (data/fixtures/edge_cases/accepted/) against the engine. No model involved.

A model proposed each case (scripts/gen_edge_cases.py) and a human accepted it, so
a failure here means the engine changed on an edge someone checked by hand.
"""

import json

import pytest

from datagen.edge_cases import EDGE_CASES, EdgeCase, load, mismatches

ACCEPTED = load("accepted")


@pytest.mark.parametrize("case", ACCEPTED, ids=[c.id for c in ACCEPTED])
def test_accepted_edge_case(case: EdgeCase):
    assert mismatches(case) == [], case.why


def test_every_case_file_is_valid_and_named_after_its_id():
    for path in EDGE_CASES.glob("*/*.json"):
        assert EdgeCase.model_validate(json.loads(path.read_text())["case"]).id == path.stem, path
