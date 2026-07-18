# Codex Project Configuration

This directory contains trusted, repository-scoped Codex configuration for the Codex Usage Dashboard.

## Contents

- `config.toml`: project defaults, bounded multi-agent limits, hook enablement, and a disabled main-thread CodeGraph server.
- `agents/explorer.toml`: fast read-only mapper for routine, well-anchored discovery with one CodeGraph explore call.
- `agents/explorer-deep.toml`: read-only mapper for ambiguous ownership and high-risk traces, also limited to one CodeGraph explore call.
- `agents/repo-impact.toml`: read-only cross-layer reviewer for API, shared types, SQLite, importer, retention, privacy, and web impact.
- `agents/repo-worker.toml`: workspace-write worker for one explicitly owned, non-overlapping implementation partition.
- `scripts/verify-model-routing.sh`: read-only config and bundled-model catalog verifier.
- `hooks.json` and `hooks/pretool-guard.sh`: block invariant violations and surface authorization, contract, schema, and verification reminders.
- Repository skills are loaded from `../.agents/skills/`.

## Models And Routing

- Codex loads this project layer only after the repository is trusted.
- The main model is intentionally not pinned: the model selected in the Codex app stays in control. `plan_mode_reasoning_effort = "xhigh"` changes planning effort only.
- `explorer`, `explorer_deep`, and `repo_impact` use `gpt-5.6-terra` at high reasoning in a read-only sandbox. Only the two search roles expose `codegraph_explore`; the main, impact, and worker surfaces do not receive CodeGraph.
- `repo_worker` uses `gpt-5.6-terra` at ultra reasoning in a workspace-write sandbox. It accepts only a complete, non-overlapping assignment and never creates further agents.
- The main thread makes an Anchor Card, selects exactly one search role when mapping is needed, and requests `repo_impact` for direct cross-layer risk. Once behavior and interfaces are fixed, it may use two or three workers only for independent, substantially similar edits with disjoint exact file sets.
- Every delegated prompt is self-contained and sets `fork_turns="none"`. The main creates the ownership map first, keeps exactly one writer per path (including itself), reviews all worker diffs, and runs final verification. It does not fan out unresolved design/contracts, dependent work, migrations, generated/codegen work, or shared intermediate output.
- `approval_policy = "on-request"`, `approvals_reviewer = "user"`, and `sandbox_mode = "workspace-write"` use Codex's recommended interactive repository baseline. The hook blocks invariant violations and warns when the current request must contain explicit authorization; normal Codex approval and sandbox flows remain available.

## Generic Routing Prompts

Use a normal task prompt; do not name a routing role. For example:

> Trace how imported session events become the dashboard's agent-attribution metrics. Identify the owning modules, direct database/API/UI effects, privacy or retention risks, and the narrowest tests before proposing the smallest implementation.

Codex selects the bounded internal route from the task anchors. A known single-file edit or direct question stays in the main thread.

For a real repeated write task, the prompt still does not need to name a subagent:

> Apply the approved agent-attribution normalization consistently to every affected importer, API/shared-type, and dashboard implementation. Preserve valid layer-local differences, decide whether any independent edits should run in parallel, keep every path single-owner, and run the narrow verification appropriate to each partition. The main task must review the combined diff and final checks.

## Setup

1. Start Codex from `/Users/VanAnh/WorkSpace/Personal/codex-usage`.
2. Trust the repository so project config and hooks load.
3. Run `codegraph init /Users/VanAnh/WorkSpace/Personal/codex-usage` once, then `codegraph sync` after large refactors if the index becomes stale.
4. Review and trust the project hook with `/hooks` after installation or whenever the hook changes.

## Restart And Runtime Proof

Configuration changes apply to newly started Codex tasks. Restart Codex from this repository root, then run:

```bash
bash .codex/scripts/verify-model-routing.sh
```

For an end-to-end proof, start a fresh task with the generic mapping prompt above and inspect the task's runtime metadata or agent trace in the Codex UI. It should show the app-selected main model and the selected read-only role at Terra/high when mapping is needed. Verify Terra/ultra workers during a real approved task using the repeated-write prompt rather than creating dummy edits; a worker should appear only after the main thread has assigned a valid independent ownership partition. A trivial prompt may correctly show no delegated role.

Do not set application `CODEX_HOME` to this repository's `.codex/` directory. This directory is agent config; live session JSONL belongs in the user's global Codex home.
