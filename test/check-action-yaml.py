# -*- coding: utf-8 -*-
"""Checks that action.yml is valid YAML and shaped like an action definition.

The unit tests read action.yml with regular expressions, which is enough to
catch a missing input mapping but cannot notice that the file no longer parses —
an unquoted `${{ ... }}` at the start of a value, or a colon inside an
unquoted description, is invalid YAML that a regular expression reads happily.
So a real parser runs over it once, in CI, where installing one is free.
"""
import sys

import yaml

REQUIRED_TOP_LEVEL = ("name", "description", "runs")


def main() -> int:
    with open("action.yml", encoding="utf-8") as handle:
        action = yaml.safe_load(handle)

    problems = []

    for key in REQUIRED_TOP_LEVEL:
        if not action.get(key):
            problems.append("action.yml has no `%s`." % key)

    runs = action.get("runs") or {}
    if runs.get("using") != "composite":
        problems.append(
            "`runs.using` is %r; every action in this family is composite so that it "
            "needs no bundled dependencies." % runs.get("using")
        )

    steps = runs.get("steps") or []
    if not steps:
        problems.append("`runs.steps` is empty.")
    for index, step in enumerate(steps):
        if "run" in step and not step.get("shell"):
            problems.append("Step %d runs a command with no `shell:`, which GitHub refuses." % index)

    for name, spec in (action.get("inputs") or {}).items():
        if not isinstance(spec, dict):
            problems.append("The `%s` input is not a mapping." % name)
            continue
        description = spec.get("description") or ""
        if "${{" in description:
            # GitHub evaluates expressions anywhere in an action definition,
            # descriptions included, and refuses to load the whole file when
            # one does not resolve: "Unrecognized named-value: 'steps'".
            problems.append(
                "The `%s` input's description contains a ${{ }} expression. "
                "GitHub evaluates those even in a description and refuses to load the action. "
                "Describe it in words instead." % name
            )
        default = spec.get("default")
        if default is not None and not isinstance(default, str):
            # A bare `true` or `30` is a boolean or an integer to YAML, and an
            # action's inputs are strings: the mismatch shows up as a comparison
            # that never matches rather than as an error.
            problems.append(
                "The `%s` input's default is %r, which is a %s. Quote it: an input is a string."
                % (name, default, type(default).__name__)
            )

    for name, spec in (action.get("outputs") or {}).items():
        if not isinstance(spec, dict) or not spec.get("value"):
            problems.append("The `%s` output has no `value`." % name)

    for problem in problems:
        print("::error::%s" % problem)
    if problems:
        return 1
    print("action.yml parses and is shaped like a composite action definition.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
