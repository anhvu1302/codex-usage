---
name: "test-gap-analysis"
description: "Find meaningful Vitest and Playwright coverage gaps using boundary, assertion-quality, regression, and pseudo-mutation review."
argument-hint: "[production files, tests, changed files, route, schema change, or user flow]"
tools: ["search/codebase", "search/usages", "read_file", "run_in_terminal"]
---

Analyze the supplied code and tests for gaps that could let incorrect behavior pass.

Check:

- Missing happy-path, boundary, malformed, duplicate, partial-record, timezone, and persistence cases.
- Assertions that would still pass after boolean inversion, removed guards, wrong totals, missing writes, stale UI, or swallowed errors.
- Import idempotency, retention boundaries, migration behavior, shared-contract alignment, and error propagation.
- Playwright coverage for changed visible workflows and accessibility-critical interactions.
- Test isolation from real session directories, real databases, and real `.env` files.

Return prioritized gaps with the exact production path, matching test location, failure the test should catch, and the narrowest command to run. Do not add tests solely to raise a percentage.
