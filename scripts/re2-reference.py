"""Runs each regex case under C++ RE2, through the google-re2 Python binding.

    python re2-reference.py <cases.json> <outcomes.json>

Reads the cases compare-regex-with-re2.mjs writes ([{pattern, inputs}]) and
writes, for each, whether RE2 compiles the pattern and, per input, the first
match's group spans, whether the whole input matches, and the span of every
match a find-all loop reaches. Spans count code points. The loop follows
re2js's Matcher.find: the next search starts where the last match ended, one
code point further after an empty match, so the two engines are asked the same
searches. A pattern or input with a lone surrogate has no UTF-8 form, so RE2
cannot be given it, and it is recorded as unencodable.
"""

import json
import sys
from importlib.metadata import version

import re2

QUIET = re2.Options()
QUIET.log_errors = False


def encodable(text):
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def span(match, group):
    start, end = match.span(group)
    return None if start is None or start < 0 else [start, end]


def input_outcome(regexp, text):
    first = regexp.search(text)
    search = (
        None
        if first is None
        else [span(first, group) for group in range(regexp.groups + 1)]
    )
    found = []
    pos = 0
    while pos <= len(text):
        match = regexp.search(text, pos)
        if match is None:
            break
        start, end = match.span()
        found.append([start, end])
        pos = end + 1 if start == end else end
    return {
        "search": search,
        "fullmatch": regexp.fullmatch(text) is not None,
        "findAll": found,
    }


def case_outcome(pattern, inputs):
    if not encodable(pattern):
        return {"pattern": pattern, "unencodable": True}
    try:
        regexp = re2.compile(pattern, options=QUIET)
    except re2.error as err:
        return {"pattern": pattern, "compiles": False, "error": str(err)}
    return {
        "pattern": pattern,
        "compiles": True,
        "inputs": [
            input_outcome(regexp, text) if encodable(text) else "unencodable"
            for text in inputs
        ],
    }


def main(cases_path, outcomes_path):
    with open(cases_path, encoding="utf-8") as cases_file:
        cases = json.load(cases_file)
    outcomes = {
        "engine": "google-re2 " + version("google-re2"),
        "cases": [case_outcome(case["pattern"], case["inputs"]) for case in cases],
    }
    with open(outcomes_path, "w", encoding="utf-8") as outcomes_file:
        json.dump(outcomes, outcomes_file)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
