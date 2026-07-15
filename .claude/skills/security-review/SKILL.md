---
name: security-review
description: Perform defensive Codex Usage security review or secure implementation for local session-data privacy, filesystem paths, Hono inputs, SQLite queries, CSV or JSON export, browser rendering, secrets, dependencies, logging, and localhost exposure.
---

# Security Review

Keep the review defensive, evidence-based, and scoped to this repository.

## Trust Boundaries

- Treat Codex JSONL, session titles, paths, prompts, tool metadata, and the usage database as private local data.
- Keep source sessions read-only. Validate configured paths and avoid following an unexpected path outside the intended root without an explicit requirement.
- Keep the HTTP listener on `127.0.0.1`. If exposure broadens, require an explicit authentication, authorization, CORS, CSRF, and rate-limit design.
- Validate query, path, and JSON inputs at the Hono boundary with bounded lengths, ranges, arrays, dates, pagination, and enums.
- Use parameterized database operations and allowlisted sort or filter fields. Reject string-built SQL from untrusted input.
- Keep CSV export formula-safe, filenames encoded safely, JSON bounded, and untrusted text rendered as text rather than HTML.
- Fail closed when classifying activity records; do not persist or log prompt bodies, tool arguments, tokens, credentials, or full private payloads.
- Keep secrets in ignored environment files. Review lockfile changes and run the production dependency audit when packages change.

## Process

1. Identify the exposed surface, attacker-controlled input, private data, and trust boundary.
2. Trace validation, storage, output, and logging with concrete file paths.
3. Rank findings Critical, High, Medium, or Low by realistic impact and reachability.
4. Prefer a minimal fix that preserves local-only behavior and data invariants.
5. Add a focused regression test and Playwright coverage when the issue is browser-observable.
6. Run relevant tests plus `pnpm audit:prod` for dependency changes.

Report evidence, exploit impact, fix guidance, verification, and residual risk. Do not report a theoretical concern as confirmed without a reachable path.
