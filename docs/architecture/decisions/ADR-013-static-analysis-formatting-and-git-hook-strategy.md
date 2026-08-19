# ADR-013 — Static Analysis, Formatting, and Git-Hook Strategy

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-18  
**Last reviewed:** 2026-08-18  
**Canonical owner/source:** ADR-013

## 1. Context

Atlas needs automated controls for different classes of engineering correctness:

```text
TypeScript → type correctness
ESLint     → suspicious or prohibited code patterns
Prettier   → deterministic formatting
Git hooks  → fast local feedback
CI         → authoritative enforcement
```

Without explicit boundaries, ESLint and Prettier can conflict, commits can become slow, hooks can be mistaken for authoritative enforcement, environment-specific rules can be applied incorrectly, and documented architectural boundaries can remain unenforced.

Atlas therefore needs one repository-level static-analysis and formatting policy with workspace-aware rules and lightweight local hooks.

## 2. Decision

Atlas will use:

- ESLint flat configuration in `eslint.config.mjs`;
- `typescript-eslint` with `recommendedTypeChecked` and TypeScript Project Service;
- Prettier as the sole formatting authority;
- `eslint-config-prettier` to disable conflicting stylistic ESLint rules;
- Husky for Git-hook installation;
- lint-staged for staged-file pre-commit checks;
- CI as the authoritative enforcement boundary.

The repository will own the shared lint and formatting tooling. Workspaces will expose independently runnable commands where appropriate.

## 3. ESLint configuration

Atlas uses one root flat configuration:

```text
eslint.config.mjs
```

The configuration contains shared rules and file-pattern-specific overrides.

Conceptually:

```text
Repository base rules
├── TypeScript rules
├── web/React rules
├── API/Node rules
├── contracts environment-neutral rules
├── test-file rules
└── architecture restrictions
```

An ESM JavaScript configuration is preferred initially. A TypeScript ESLint configuration file is not required because it would introduce additional execution setup without meaningful architectural value.

### 3.1 Typed linting

Atlas enables type-aware linting using:

```text
typescript-eslint
recommendedTypeChecked
parserOptions.projectService
```

`recommendedTypeChecked` is selected instead of `strictTypeChecked` initially.

The intent is to catch meaningful problems involving asynchronous code, unsafe values, and TypeScript semantics without adopting the stronger and more opinionated rule set prematurely.

Typed ESLint does not replace TypeScript verification.

The repository continues to require:

```text
tsc --noEmit
```

for authoritative TypeScript type-checking.

### 3.2 Environment-specific rules

#### Web

The web configuration applies:

- TypeScript type-aware rules;
- React Hooks rules;
- React Refresh rules where appropriate;
- browser globals.

#### API

The API configuration applies:

- TypeScript type-aware rules;
- Node globals;
- asynchronous error/promise safety;
- restrictions preventing Express and infrastructure leakage into domain/application code.

#### Contracts

The contracts configuration applies:

- TypeScript type-aware rules;
- no browser globals;
- no Node globals;
- no React dependencies;
- no Express dependencies.

#### Tests

Tests may receive narrowly justified differences, such as test-framework globals.

Test files must not receive broad exemptions from strict rules merely because they are tests.

## 4. Architectural dependency enforcement

Atlas will make documented dependency boundaries machine-checkable where practical.

Initial rules include:

- applications cannot import another application's source;
- workspaces cannot bypass package boundaries with relative imports;
- backend modules cannot import another module's internal files;
- frontend features cannot import another feature's internal files;
- `@atlas/contracts` cannot depend on API, web, Node, DOM, React, or Express;
- domain/application code cannot import infrastructure or transport implementations;
- circular module relationships are prohibited.

Initial enforcement should use ESLint file-pattern overrides and restricted-import rules where those rules can express the required boundary clearly.

A specialized dependency-boundary tool is deferred until the required dependency graph becomes too complex for core ESLint mechanisms to express and maintain reliably.

The governing principle is:

```text
documented boundary
        +
automated verification
```

An architectural rule that cannot reasonably be checked should remain explicit documentation until a suitable enforcement mechanism is justified.

## 5. Formatting

Prettier owns deterministic formatting.

ESLint owns code-quality, safety, and architectural rules.

Atlas uses:

```text
Prettier
+
eslint-config-prettier
```

Atlas will not initially use:

```text
eslint-plugin-prettier
```

Formatting should therefore not appear as an ESLint diagnostic. Developers can format explicitly, while linting focuses on code-quality and architectural correctness.

## 6. Tool ownership

Repository-level ownership is:

```text
Repository root
├── ESLint runtime and plugins
├── Prettier
├── Husky
├── lint-staged
└── canonical configurations

Workspaces
└── independently runnable lint/format targets where appropriate
```

Atlas will not create an `@atlas/eslint-config` package merely to wrap the configuration for one repository.

A shareable configuration package may be reconsidered if multiple independently versioned repositories or external consumers need the same policy.

## 7. Command contracts

The repository establishes these conceptual command contracts:

```text
pnpm lint
→ lint all applicable repository source

pnpm lint:fix
→ apply safe lint fixes locally

pnpm format
→ write Prettier formatting locally

pnpm format:check
→ verify formatting without writing

pnpm verify
→ typecheck
  + lint
  + format:check
  + dependency-boundary checks
  + non-E2E tests
```

Workspace-scoped commands must also be possible:

```text
pnpm --filter @atlas/web lint
pnpm --filter @atlas/api lint
pnpm --filter @atlas/contracts lint
```

Exact script composition remains an implementation detail.

### 7.1 CI behavior

CI uses non-mutating verification commands.

CI must report required changes rather than rewrite the checkout.

CI is authoritative even when local Git hooks are installed because developers can disable or bypass hooks and because CI must provide a consistent enforcement boundary.

## 8. Warning and suppression policy

CI linting uses:

```text
--max-warnings 0
```

A warning that can remain indefinitely provides weak enforcement.

Rules must therefore either:

- fail when violated;
- be disabled with documented rationale;
- or remain deferred until Atlas is ready to enforce them.

Unused ESLint suppression comments must fail linting.

Necessary suppressions must be narrow and explain why the rule does not apply.

## 9. Git-hook strategy

Atlas uses:

```text
Husky
    ↓ pre-commit
lint-staged
    ↓
only staged applicable files
├── ESLint safe fixes
└── Prettier formatting
```

The pre-commit hook is intentionally lightweight.

It will:

- format applicable staged files;
- run ESLint safe fixes against staged source;
- reject remaining lint failures.

It will not initially run:

- the complete test suite;
- E2E tests;
- database startup;
- the full production build;
- dependency installation;
- network operations.

No pre-push hook is required initially.

The hook is a convenience boundary for fast local feedback, not the source of truth.

## 10. Why full verification is not a pre-commit requirement

Running the full repository test suite, E2E tests, database setup, or production build on every commit would add substantial latency.

The expected failure mode is developers bypassing hooks to avoid slow commits.

Atlas instead separates:

```text
pre-commit
→ fast staged-file feedback

CI / explicit verify
→ authoritative repository-wide verification
```

Broader local checks remain available through `pnpm verify`.

A pre-push hook may be reconsidered when evidence shows that a useful subset of checks can run quickly enough to improve feedback without materially harming developer flow.

## 11. Consequences

### Positive

- Formatting is deterministic and separated from lint diagnostics.
- Type-aware linting catches classes of issues ordinary ESLint cannot.
- `tsc --noEmit` remains the dedicated TypeScript correctness check.
- Architectural boundaries become machine-checkable where practical.
- Workspace-specific environments receive appropriate rules.
- Pre-commit feedback remains fast.
- CI provides authoritative enforcement independent of local hook configuration.

### Negative

- The root ESLint configuration becomes more sophisticated as Atlas grows.
- Type-aware linting can increase lint execution time.
- Architectural restrictions require ongoing maintenance as module boundaries evolve.
- Developers must understand the distinction between formatting, linting, type-checking, tests, and CI verification.
- Some boundaries may initially require documentation until an adequate automated enforcement mechanism is available.

## 12. Deferred decisions

The following are intentionally deferred:

- `strictTypeChecked`;
- a specialized dependency-boundary tool;
- a shareable `@atlas/eslint-config` package;
- a pre-push hook;
- full tests or production builds in Git hooks;
- additional repository-wide lint rules not justified by current code;
- automated CI secret scanning;
- exact versions of ESLint, Prettier, Husky, lint-staged, and related plugins.

## 13. Reconsideration criteria

Revisit this ADR when one or more of the following becomes true:

- core ESLint restrictions can no longer express Atlas's dependency graph reliably;
- lint performance becomes materially disruptive;
- multiple repositories require the same configuration;
- stricter type-aware linting provides demonstrated value;
- pre-push verification can provide materially earlier feedback at acceptable latency;
- the current hook model creates measurable workflow or reliability problems.

Any change to the selected architecture should be recorded through the ADR governance process.

## 14. Related decisions

- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-006 — Node.js Runtime Baseline](ADR-006-nodejs-runtime-baseline.md)
- [ADR-007 — TypeScript Module, Execution, and Build Strategy](ADR-007-typescript-module-execution-and-build-strategy.md)
- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-009 — Frontend Application Architecture](ADR-009-frontend-application-architecture.md)
- [ADR-011 — PostgreSQL Runtime and Local Development Strategy](ADR-011-postgresql-runtime-and-local-development-strategy.md)
- [ADR-012 — Configuration, Environment, and Secrets Strategy](ADR-012-configuration-environment-and-secrets-strategy.md)

## 15. References

- [ESLint configuration documentation](https://eslint.org/docs/latest/use/configure/configuration-files)
- [typescript-eslint typed linting](https://typescript-eslint.io/troubleshooting/typed-linting/)
- [typescript-eslint configurations](https://typescript-eslint.io/users/configs/)
- [Prettier linter integration](https://prettier.io/docs/next/integrating-with-linters.html)
- [Husky documentation](https://typicode.github.io/husky/)

## Status summary

**Status: Proposed**

The selected tooling and enforcement model are defined. Acceptance should follow repository validation of the configuration, workspace lint commands, architecture restrictions, and related ADR links.
