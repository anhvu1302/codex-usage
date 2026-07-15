---
description: "React/Vite rules for browser API clients, shared contracts, TanStack Query state, reusable UI components, accessibility, and verification."
name: "React And Vite Rules"
applyTo: "src/web/**,vite.config.ts,index.html"
---

# React And Vite Rules

## Data Access

- Keep HTTP calls in the existing modules under `src/web/lib`; components should consume typed functions or query hooks.
- Use relative `/api` routes so development middleware and production hosting share the same origin. Do not hard-code hostnames or ports.
- Reuse request/response contracts from `src/shared` and update Hono handlers, client functions, and consumers together.
- Keep TanStack Query keys stable and specific. Invalidate or update cached data deliberately after mutations.
- Handle aborts, stale responses, retry behavior, and error messages without hiding actionable failures.

## Components And State

- Preserve the component conventions under `src/web/components/ui`, existing Tailwind utilities, and established chart/table patterns.
- Keep state close to its owner. Avoid duplicated derived state and effects that can be expressed as render-time derivation.
- Avoid `any`; narrow unknown data at boundaries and keep component props explicit.
- Cover loading, empty, success, error, disabled, and permission-independent local failure states.
- Keep dense dashboard views scannable on desktop and usable at narrow widths.

## Accessibility

- Prefer semantic elements and existing accessible primitives.
- Ensure form labels, keyboard order, focus visibility, dialog focus management, button names, contrast, and chart/table alternatives remain usable.
- Announce asynchronous success and failure appropriately without producing noisy repeated notifications.

## Safety

- Never expose raw session content unnecessarily or render untrusted text as HTML.
- Never read or edit a real `.env` file.
- Keep browser traffic on the loopback-hosted application and do not add direct filesystem access.

## Verification

- Run `pnpm typecheck` while iterating.
- Run targeted Vitest files for pure non-DOM utility logic; use Playwright for rendered component and user-flow behavior.
- Run a targeted Playwright spec for changed user workflows, routing, filtering, data presentation, or accessibility.
- Run `pnpm build:web` before completion for browser bundling or entry-point changes.
- Fix and rerun failed checks before reporting completion.
