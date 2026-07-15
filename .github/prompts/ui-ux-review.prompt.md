---
name: "ui-ux-review"
description: "Review the Codex Usage React dashboard for component consistency, accessibility, responsive behavior, information clarity, and complete UI states."
argument-hint: "[screen, component, changed files, screenshot, or user flow]"
tools: ["search/codebase", "search/usages", "read_file"]
---

Review the supplied UI against existing patterns under `src/web/components/ui`.

Check visual hierarchy, information density, loading/empty/error/success states, narrow layouts, keyboard navigation, focus, labels, contrast, chart/table comprehension, notification behavior, and preservation of user preferences.

Return prioritized findings with exact component paths, user impact, and concrete minimal changes. Include the targeted Playwright spec and accessibility checks needed to verify the result.
