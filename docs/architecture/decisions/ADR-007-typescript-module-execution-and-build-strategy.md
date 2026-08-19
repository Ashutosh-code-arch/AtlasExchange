# ADR-007: TypeScript Module, Execution, and Build Strategy

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-17  
**Last reviewed:** 2026-08-17
**Canonical owner/source:** ADR-007

## Context

Atlas has three TypeScript environments:

| Workspace          | Executes where | Compilation model                                  |
| ------------------ | -------------- | -------------------------------------------------- |
| `@atlas/web`       | Browser        | Vite bundles the application                       |
| `@atlas/api`       | Node.js        | TypeScript emits Node-compatible JavaScript        |
| `@atlas/contracts` | Web and API    | Compile reusable JavaScript plus type declarations |

They share strictness rules but require environment-specific TypeScript configurations. Browser code needs DOM types and bundler resolution; API code needs Node types and Node module resolution; contracts must not depend on browser or Node globals.

Atlas also separates execution from verification:

```text
dev        → run with fast transformation/watch
typecheck  → TypeScript verification
build      → production artifacts
test       → test execution
```

Vite and `tsx` do not replace TypeScript type-checking.

## Decision Drivers

The strategy should:

1. standardize Atlas-owned code on ESM;
2. permit compatible third-party CommonJS dependencies;
3. optimize development for fast feedback;
4. produce deterministic JavaScript production artifacts;
5. avoid unnecessary backend bundling;
6. make `@atlas/contracts` a defined package boundary;
7. keep environment-specific `tsconfig` settings separate;
8. keep type verification separate from runtime transformation;
9. defer project-reference complexity until justified.

# Decision

Atlas standardizes **Atlas-owned TypeScript code on ESM**.

```text
@atlas/web
  Development → Vite
  Type-check  → tsc --noEmit
  Production  → Vite bundle → dist/

@atlas/api
  Development → tsx watch
  Type-check  → tsc --noEmit
  Production  → tsc → dist/ → node

@atlas/contracts
  Type-check  → TypeScript
  Test        → Vitest
  Build       → tsc → ESM JavaScript + .d.ts
```

Third-party CommonJS dependencies remain acceptable where Node 24 can consume them compatibly.

## 1. Web

`@atlas/web` uses:

- ESM source;
- `moduleResolution: "Bundler"`;
- no TypeScript production emission;
- Vite for development and production bundling;
- `tsc --noEmit` for type verification.

```text
TypeScript → Vite → browser bundle
TypeScript → tsc --noEmit → type verification
```

## 2. API Development

`@atlas/api` uses `tsx watch` for development because the development workflow prioritizes fast startup, transformation, and watch/restart feedback.

`tsx` is not the type-checking authority.

```text
TypeScript → tsx watch → development execution
TypeScript → tsc --noEmit → verification
```

## 3. API Production

The API initially remains **unbundled**.

Production uses TypeScript to emit JavaScript and standard Node.js to execute it:

```text
TypeScript → tsc → dist/*.js → node
```

The API uses:

- ESM;
- `module: "NodeNext"`;
- `moduleResolution: "NodeNext"`;
- source maps for operational debugging.

Node ESM relative imports normally use emitted `.js` extensions:

```ts
import { createApp } from "./app.js";
```

Development and production intentionally use different execution paths: development optimizes feedback speed, while production optimizes deterministic artifacts and standard Node execution.

## 4. Backend Bundling

Backend bundling is deferred.

`tsc` output is initially preferred because it preserves standard Node module/dependency behavior and avoids another transformation layer.

Bundling becomes a candidate only when a measurable requirement exists, such as:

- serverless packaging constraints;
- material cold-start requirements;
- a deployment platform benefiting from one bundle;
- artifact-size or file-count requirements;
- another demonstrated operational constraint.

A future decision must consider dependency handling, native modules, dynamic imports, source maps, stack traces, debugging, build complexity, and deployment behavior.

## 5. Contracts

`@atlas/contracts` compiles to a package surface containing ESM JavaScript and `.d.ts` declarations:

```text
dist/
├── index.js
├── index.d.ts
└── ...
```

It remains a private pnpm workspace package; npm publication is not implied.

Web and API consumers explicitly depend on `@atlas/contracts`.

The package boundary is preferred over exposing raw TypeScript because consumers depend on a defined interface rather than source layout, do not require a TypeScript runtime loader, and can consume declarations independently.

```text
@atlas/web ────────┐
                   ├──> @atlas/contracts
@atlas/api ────────┘
```

Contracts must remain independent of DOM and Node globals.

## 6. TypeScript Configuration

Atlas uses:

```text
tsconfig.base.json
apps/web/tsconfig.json
apps/api/tsconfig.json
packages/contracts/tsconfig.json
```

The base contains genuinely shared rules such as strictness, casing consistency, unused-code policy, safe optional-property/indexed-access behavior, and applicable interoperability rules.

The base must not impose DOM libraries, Node libraries, a universal module-resolution mode, a universal output directory, or browser/server globals.

Workspace configurations own environment-specific settings.

## 7. Type Verification

Responsibilities remain separate:

```text
Vite / tsx    → development transformation/execution
tsc --noEmit  → type verification
tsc           → API/contracts production compilation
Vitest        → test execution
```

A successful development server is not evidence of type correctness.

## 8. Project References

Atlas will **not introduce TypeScript project references initially**.

With three workspaces, pnpm already expresses the package dependency graph:

```text
pnpm workspace dependency graph
        ↓
explicit topological build and development commands
```

Project references may be introduced when measurable needs emerge around TypeScript-owned build ordering, incremental compilation, editor/build performance, or a substantially larger workspace graph.

# Alternatives Considered

## Native Node TypeScript Execution

Rejected as the primary API strategy because Node's native support does not type-check and has restricted transformation behavior. It does not establish a complete `tsconfig`-driven application execution strategy and does not solve all TypeScript syntax or aliasing requirements.

## `tsx` for Development and Production

Rejected because a development execution tool should not become an unnecessary production runtime dependency. Production should execute deterministic JavaScript artifacts with Node.

## Bundled API

Rejected initially because Atlas has no demonstrated backend-bundling requirement. Bundling adds transformation and debugging/dependency complexity.

## Raw TypeScript Contracts

Rejected because consumers would depend on source layout and potentially require TypeScript-aware runtime/build tooling. Compiled ESM plus `.d.ts` provides the clearer package boundary.

## TypeScript Project References from Sprint 1

Rejected initially because three workspaces do not yet demonstrate sufficient need for the additional `composite` and declaration-build requirements. pnpm already models the dependency graph.

# Consequences

### Positive

- Consistent ESM model for Atlas-owned code.
- Fast API development through `tsx watch`.
- Standard Node.js JavaScript production execution.
- Explicit `tsc --noEmit` type verification.
- Defined compiled boundary for `@atlas/contracts`.
- Environment-specific TypeScript configuration.
- No premature backend-bundling or project-reference complexity.

### Negative

- Developers must understand separate API development and production execution paths.
- API production requires compilation.
- Contracts require a build workflow.
- Atlas-owned ESM code follows Node ESM semantics.
- Future scaling may justify additional build coordination or bundling.

# Deferred Decisions

1. Exact TypeScript compiler version.
2. Complete workspace `tsconfig` option sets beyond the boundaries established here.
3. Exact pnpm script composition.
4. API deployment platform and packaging details.
5. Backend bundling.
6. TypeScript project references.

Exact commands, file layout, package exports, source-map settings, and version pins remain implementation details unless they alter these architectural boundaries.

# Reconsideration Criteria

Reconsider when measurable requirements emerge, including:

- unbundled API output becoming materially inadequate for deployment;
- workspace scale making project references materially beneficial;
- TypeScript build performance becoming a significant development or CI bottleneck;
- Node/deployment constraints requiring another module or artifact strategy;
- contract distribution requirements changing;
- critical tooling changes invalidating current assumptions.

Any reconsideration should evaluate developer workflow, CI, build performance, debugging, source maps, deployment, dependency behavior, and migration complexity.

# Relationship to Other Decisions

- [ADR-006 — Node.js Runtime Baseline](ADR-006-nodejs-runtime-baseline.md)
- [ADR-005 — Sprint 1 Testing Toolchain](ADR-005-sprint-1-testing-toolchain.md)
- [ADR-002 — Project Folder Structure](ADR-002-project-folder-structure.md)
- [ADR-003 — Workspace and Package Management Strategy](ADR-003-workspace-and-package-management-strategy.md)
- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [Documentation Governance](../../governance/documentation-governance.md)

# Status

**Accepted**

Atlas standardizes its own TypeScript code on ESM, uses Vite for web development and production bundling, uses `tsx watch` for API development, uses unbundled `tsc` output for API production, and compiles `@atlas/contracts` into ESM JavaScript plus `.d.ts` declarations.

Backend bundling and TypeScript project references remain deferred until measurable requirements justify them.
