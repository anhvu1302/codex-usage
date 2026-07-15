---
name: frontend-api
description: Implement or review React-to-Hono API integration in Codex Usage, including shared TypeScript contracts, same-origin fetch wrappers, query serialization, TanStack Query usage, error handling, and user-visible states.
---

# Frontend API

Keep network behavior typed, centralized, and consistent with the Hono route.

## Rules

- Define browser-visible request and response shapes in `src/shared/types.ts` and import them with `import type`.
- Add endpoint wrappers beside related functions in `src/web/lib/api.ts`, `activity-api.ts`, or `product-api.ts`; do not fetch directly from presentation components.
- Use same-origin `/api/*` paths. Encode path segments, build query strings with `URLSearchParams`, and omit optional filters deliberately.
- Follow the existing request helper behavior: JSON headers, parsed error payloads, and thrown errors for non-success responses.
- Keep caching, invalidation, polling, and mutations in TanStack Query hooks near the owning screen. Use stable query keys that contain every effective filter.
- Cover loading, empty, success, stale, disabled, and error states. Prevent duplicate submissions and preserve keyboard behavior.
- Do not add a generated client or a parallel contract model.

## Contract Changes

Update the Hono parser and response, `src/shared/types.ts`, the fetch wrapper, callers, Vitest coverage, and affected Playwright flow as one change. Use `$contract-rollout` when compatibility or migration order matters.

## Verification

Run `pnpm typecheck`, the narrow relevant tests, and `pnpm test:e2e` for a changed user flow. Run `pnpm build` when routing, imports, or production behavior changed. Fix and rerun any failed command before completion.
