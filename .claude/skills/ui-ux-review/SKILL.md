---
name: ui-ux-review
description: Review or implement Codex Usage UI and UX in the React, Vite, Tailwind, Radix, Lucide, and Recharts frontend, including accessibility, responsive layout, dashboard clarity, interaction states, theme, density, and browser verification.
---

# UI UX Review

Prioritize clear data interpretation, efficient repeated use, accessibility, and consistency with nearby screens.

## Review Focus

- Reuse components in `src/web/components` and `src/web/components/ui`; follow existing Tailwind tokens, Radix primitives, Lucide icons, theme, and density patterns.
- Review the whole flow: navigation, filters, primary action, validation, loading, stale, empty, success, error, disabled, and destructive states.
- Keep filters and URL state understandable and reversible. Preserve values across navigation where the existing preference layer does so.
- Make dashboards scannable: clear hierarchy, stable units, honest precision, comparable scales, useful legends, and explicit timezone or retention caveats.
- Keep large tables, charts, drawers, dialogs, and sidebars usable on narrow screens without clipped labels or hidden actions.
- Use semantic labels, logical heading order, keyboard access, visible focus, adequate contrast and targets, and non-color-only status cues.
- Respect reduced motion. Animate only when it clarifies state and does not delay interaction.
- Avoid nested decorative containers, excessive cards, and dense chart effects that obscure operational data.

## Process

1. Inspect the owning page and nearby components before changing a pattern.
2. Review at desktop and mobile widths; use a browser screenshot for visual claims.
3. Check keyboard flow and browser console errors.
4. Rank findings by user impact and cite concrete paths.
5. Keep implementation scoped and reuse existing primitives.
6. Run `pnpm typecheck`, affected tests, `pnpm test:e2e`, and `pnpm build` as justified.

Report user impact, evidence, changed states, responsive and accessibility checks, verification, and remaining limitations.
