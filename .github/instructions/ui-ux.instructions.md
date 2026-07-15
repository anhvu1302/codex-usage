---
description: "UI/UX rules for the Codex Usage React dashboard, reusable components, charts, tables, forms, responsive layouts, and accessibility."
name: "UI UX Rules"
applyTo: "src/web/**,e2e/**"
---

# UI UX Rules

- Preserve the existing visual language and reusable primitives under `src/web/components/ui`.
- Keep usage analysis workflows dense, scannable, and action-oriented; prioritize readable totals, filters, charts, tables, and drill-downs.
- Cover loading, empty, success, error, disabled, stale, and responsive states.
- Ensure text fits, tables remain navigable, charts have understandable labels, and controls do not overlap at narrow widths.
- Use semantic HTML, visible focus, keyboard-safe dialogs/popovers, labeled controls, sufficient contrast, and non-color-only status cues.
- Prefer familiar controls and consistent placement for repeated actions. Avoid decorative patterns that obscure operational data.
- Preserve user preferences when the existing preference layer owns them.
- Verify changed workflows with a targeted Playwright spec and accessibility checks when applicable.
