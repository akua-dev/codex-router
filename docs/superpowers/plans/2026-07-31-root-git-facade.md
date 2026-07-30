# Root Git Facade Implementation Plan

**Goal:** Make the public `codex-router` repository directly consumable as one full-SHA-pinned Bun
Git dependency, then replace AgentOS PR #70's vendored snapshot with that canonical package.

**Architecture:** Export the existing private workspace entry points through the root package,
make production cross-package imports self-contained, and keep runtime-specific code behind
explicit Bun and Cloudflare subpaths. AgentOS remains a thin consumer.

**Tech Stack:** Bun, TypeScript, Effect `4.0.0-beta.102`, Vitest, GitHub Git dependencies,
Cloudflare Workers, AgentOS AI Gateway.

## Task 1: Specify and test the root facade

- Add a focused failing test that imports every supported root subpath.
- Confirm the failure is the missing root export contract.
- Add root export mappings and the aligned runtime Effect dependency union.
- Replace production workspace-name imports with public-index-relative imports.
- Keep child workspaces private and retain their local development manifests.

## Task 2: Document and verify the public Git contract

- Document full-SHA installation and facade imports in `README.md` and `AGENTS.md`.
- Run the focused package test and the full `bun run check` gate.
- Audit tracked files and Git history for credentials.
- Push the verified root facade to `main`, make the GitHub repository public, and install that exact
  commit into a clean temporary Bun consumer.

## Task 3: Replace the AgentOS snapshot

- Remove `vendor/codex-router` and its workspace/test wiring.
- Pin `@akua-dev/codex-router` to the verified public commit.
- Change AI Gateway imports to `/core`, `/codex`, and `/bun`.
- Regenerate the lockfile and update Docker production-dependency staging.
- Update AgentOS architecture, operator, and contributor guidance to describe the shared-package
  boundary and commit-pin update workflow.

## Task 4: Verify and deliver PR #70

- Run focused telemetry, AI Gateway, compaction, package-integration, and Kubernetes manifest tests.
- Run the applicable AgentOS type, lint, formatting, and full test gates.
- Confirm the final diff has no vendored router source and record the new line count.
- Commit and push explicitly to `feat/fleet-otel-observability-pr`.
- Update the existing PR body and checklist to match the final head.
- Wait for ordinary PR CI, report the exact head and check state, and do not merge.
