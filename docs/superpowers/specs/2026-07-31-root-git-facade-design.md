# Root Git Facade Design

**Date:** 2026-07-31

**Status:** Approved for implementation

## Outcome

`akua-dev/codex-router` becomes a public repository whose root package is the canonical external
dependency. Bun and Cloudflare consumers install one full-SHA-pinned Git dependency and import
explicit subpaths:

- `@akua-dev/codex-router/core`
- `@akua-dev/codex-router/codex`
- `@akua-dev/codex-router/bun`
- `@akua-dev/codex-router/cloudflare`
- `@akua-dev/codex-router/relay`

The internal workspace packages remain useful development boundaries, but they are private and are
not independently installed from the Git repository. This avoids a package registry and removes
AgentOS's divergent source snapshot.

## Why a Root Facade Is Required

Bun can install a Git repository root, including a full commit pin, but it does not install that
repository's child workspaces as separately resolvable packages. The current child package sources
import names such as `@akua-dev/codex-router-core`, which only resolve after the monorepo's own
workspace install.

The root facade solves that mismatch:

1. the root manifest exports each supported package entry point;
2. production source uses relative imports when crossing an internal package boundary;
3. the root manifest declares the union of runtime Effect dependencies required by those entry
   points;
4. a clean consumer can resolve the facade without workspace symlinks or a registry.

This is intentionally source-first. Bun and Wrangler consume TypeScript directly, so generated
distribution artifacts and a second build/release pipeline would add drift without helping the
supported runtimes.

## Package and Effect Boundaries

The architectural direction remains:

```text
core <- codex <- bun
              <- cloudflare
              <- relay
```

Relative internal imports do not relax these layers. They only make the Git-installed root package
self-contained. Cross-package imports must target the public source index of the dependency package,
not reach into private implementation files.

The root package declares the aligned Effect runtime dependencies used by its exported source:

- `effect`
- `@effect/platform-bun`
- `@effect/platform-browser`
- `@effect/sql-sqlite-bun`
- `@effect/sql-sqlite-do`

All remain pinned to the repository's single verified Effect release. Test-only packages remain
development dependencies.

## Consumer Contract

Consumers use a full commit SHA:

```json
{
  "dependencies": {
    "@akua-dev/codex-router": "github:akua-dev/codex-router#<full-commit-sha>"
  }
}
```

They import only the facade subpaths. A branch, tag, short SHA, child workspace URL, GitHub
subdirectory proxy, or registry proxy is not the production contract.

The repository remains marked `private: true` in `package.json` to prevent accidental publication
to npm. GitHub repository visibility is independent of npm publication.

## AgentOS Integration

AgentOS removes `vendor/codex-router` and its workspace entries. Its AI Gateway depends on the
full-SHA-pinned root Git package and imports `/core`, `/codex`, and `/bun`.

`codex-router` owns:

- quota-aware selection and rejection diagnostics;
- Codex protocol, OAuth, usage, and transparent model forwarding;
- portable routing state contracts;
- Bun persistence and maintenance implementations;
- Cloudflare runtime implementations.

AgentOS owns only its adapters and deployment concerns:

- AgentOS OAuth and quota observations;
- persistence wiring;
- privacy-bounded OTEL and correlation;
- AI Gateway route policy and deployment;
- Kubernetes and operator workflow.

AgentOS must not copy routing policy or run the upstream repository's own test suite. Its focused
tests prove the pinned package integrates with the thin adapters; `codex-router` CI proves the
package itself.

## Verification

The change is accepted only when:

1. root-facade imports pass in the monorepo;
2. a clean temporary Bun project installs the public repository at the exact pushed SHA and imports
   every facade subpath without workspace links;
3. `bun run check` and `git diff --check` pass in `codex-router`;
4. AgentOS has no tracked `vendor/codex-router` files or stale workspace dependency names;
5. AgentOS focused AI Gateway, telemetry, compaction, package-integration, and Kubernetes tests pass;
6. the existing AgentOS PR head is updated and ordinary PR CI is green.

Repository visibility changes only after a tracked-file and history secret audit. No PR is opened
for `codex-router`, and no duplicate AgentOS PR is created.
