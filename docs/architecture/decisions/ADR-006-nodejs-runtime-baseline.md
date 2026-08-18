# ADR-006: Node.js Runtime Baseline

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-16  
**Last reviewed:** 2026-08-16  
**Canonical owner/source:** ADR-006

## Context

Atlas needs a defined Node.js runtime baseline for local development, CI, dependency compatibility, and eventual production deployment.

Without an explicit runtime baseline, developers and CI can execute different Node.js versions, creating environment drift and making dependency behavior difficult to reproduce.

As of 2026-08-16:

| Release line | Current status | End of life | Atlas fit |
|---|---|---|---|
| Node 22 | Maintenance LTS | 2027-04-30 | Supported, but shorter remaining life |
| Node 24 | Active LTS | 2028-04-30 | Preferred production baseline |
| Node 26 | Current | 2029-04-30 | Not LTS until October 2026 |

Node 24 is the preferred baseline because it is the newest production-recommended LTS line with a longer remaining support window than Node 22. Node 26 remains Current and is therefore not selected as the production baseline today.

## Decision Drivers

The runtime baseline should:

1. use a production-supported LTS release;
2. provide a sufficiently long support window for a new project;
3. be compatible with Atlas's selected tooling;
4. provide the same runtime family across local development and CI;
5. allow exact execution-version reproducibility;
6. avoid making a Current release the production baseline solely for newer features;
7. establish explicit upgrade and review criteria;
8. keep runtime selection separate from the TypeScript build and execution strategy.

# Decision

Atlas will use **Node.js 24.x as its architectural runtime baseline**.

The initial approved execution version is **Node.js 24.19.0**.

These are separate controls:

```text
Supported runtime line
→ Node 24.x, excluding future majors

Approved execution version
→ exactly 24.19.0 initially
```

The exact approved version is used consistently by:

- developer version-manager configuration;
- CI;
- package-manager environment checks;
- future deployment configuration.

The ADR establishes the supported major-version line. The exact execution version is an implementation-level reproducibility control and may be updated deliberately within `24.x` without creating a new architectural decision.

## 1. Why Active LTS Instead of Current

Atlas chooses an Active LTS release rather than the newest Current release because the production baseline should optimize for stability, predictable support, security maintenance, and ecosystem compatibility rather than immediate access to the newest runtime features.

A Current release can be suitable for experimentation, but it should not become Atlas's production baseline solely because it is newer.

Therefore:

```text
Production baseline
        ↓
Active/Maintenance LTS
        ↓
Predictable support + ecosystem compatibility
```

Node 26 remains a future candidate rather than the current production baseline.

## 2. Why Node 24 Instead of Node 22

Node 22 remains supported, but Node 24 provides the longer remaining support window and is the newer LTS line.

For a new Atlas repository, choosing Node 24 avoids establishing the project on an older supported major when a newer Active LTS release is already available.

This is a lifecycle decision, not a claim that Node 22 is unsuitable.

## 3. Node 24 Non-Major Upgrade Policy

Compatible minor and patch updates within `24.x` are maintenance changes.

For example:

```text
24.19.0 → 24.19.1   # patch
24.19.1 → 24.20.0   # minor
```

Neither changes the architectural major-version baseline.

Non-major updates require:

- compatibility verification;
- the normal repository test and verification process;
- synchronized version pins across local development and CI;
- deliberate approval of the new exact execution version.

They do **not** require a new ADR.

Major-version changes, such as:

```text
24.x → 26.x
```

require a runtime-baseline review.

The review must consider runtime compatibility, dependency compatibility, build and development tooling, CI, deployment, security, migration effort, and rollback strategy.

## 4. Supported Runtime Range Versus Exact Pin

Atlas intentionally separates compatibility policy from reproducible execution.

The supported runtime line is:

```text
Node 24.x
```

The approved execution version is:

```text
24.19.0
```

During implementation, the package engine range should reject older unsupported Node versions and future major versions.

Version-manager and CI configuration should pin the exact approved execution version.

The exact enforcement files and version-manager choice remain implementation details and are not selected by this ADR.

## 5. Node 26 Upgrade Trigger

Node 26 is not selected today because it remains Current.

Atlas should formally reassess Node 26 after:

1. Node 26 enters LTS;
2. Atlas's dependencies and tooling officially support **or demonstrate compatibility with** Node 26;
3. CI and deployment environments support Node 26;
4. migration and verification effort are understood.

The normal trigger is:

```text
Node 26 enters LTS
        +
Atlas ecosystem supports or demonstrates compatibility
        ↓
Reassess runtime baseline
```

An earlier review may be triggered by:

- a critical security issue affecting Node 24;
- a critical dependency dropping Node 24 support;
- a required Atlas capability that cannot reasonably operate on Node 24;
- a deployment/platform constraint requiring a newer supported runtime.

Moving to Node 26 later is an expected lifecycle upgrade, not a failure of this ADR.

## 6. TypeScript Execution Is a Separate Decision

Node 24 can execute certain TypeScript directly by stripping erasable types.

Atlas does **not** interpret that capability as a decision to adopt native TypeScript execution as its project-wide strategy.

Native TypeScript execution does not by itself determine:

- build strategy;
- development execution;
- module format;
- source-map behavior;
- production artifacts;
- package boundaries;
- TypeScript verification.

Therefore:

```text
Runtime TypeScript execution
        ≠
TypeScript type verification
```

Node's type stripping does not replace `tsc` verification.

The project's TypeScript module, build, development-execution, and production-artifact strategy will be established separately.

# Alternatives Considered

## Alternative 1: Node 22 LTS

### Benefits

- Supported LTS release.
- Mature ecosystem compatibility.
- Established production usage.

### Rejected because

Node 24 is already an Active LTS release and provides a longer remaining support window.

For a new Atlas repository, choosing Node 22 would establish the project on an older supported major without a compelling compatibility requirement.

Node 22 remains a valid fallback if a required dependency or deployment environment later makes Node 24 unsuitable.

## Alternative 2: Node 26 Current

### Benefits

- Newest runtime line.
- Longer projected support lifetime.
- Access to newer runtime capabilities.

### Rejected because

Node 26 is still Current on the ADR decision date and is not yet the LTS production baseline.

Atlas prioritizes an established LTS release for the production runtime.

Node 26 should be reassessed after entering LTS and after Atlas's dependency and tooling ecosystem supports or demonstrates compatibility with it.

## Alternative 3: Unpinned Node 24

For example:

```text
Node >= 24
```

### Rejected because

A broad range does not provide reproducible local and CI execution.

Different developers or environments could silently run different Node 24 versions, increasing environment drift.

Atlas therefore uses Node 24.x as the architectural baseline and an exact approved execution version for reproducibility.

## Alternative 4: Make One Exact Patch the Architectural Baseline

For example:

```text
Node 24.19.0
```

### Rejected because

Patch and minor releases within Node 24 are maintenance-level updates.

Making a specific patch the architectural baseline would unnecessarily turn routine non-major updates into architectural decisions.

The architecture selects the `24.x` line; implementation controls pin the currently approved execution version.

## Alternative 5: Adopt Native Node TypeScript Execution

### Benefits

- Reduces the need for a separate runtime TypeScript transformer in supported cases.
- Uses a capability provided by the Node runtime.

### Rejected as an ADR-006 decision because

Runtime support for TypeScript syntax does not define Atlas's complete TypeScript strategy.

Build output, development execution, module format, source maps, production artifacts, and type verification remain separate concerns.

Node's type stripping also does not replace `tsc` verification.

# Consequences

## Positive Consequences

### Consistent runtime baseline

Developers, CI, and future deployment configuration share the Node 24 runtime family and approved execution version.

### Longer supported lifetime

Atlas starts on the newer LTS line rather than Node 22, reducing near-term pressure for a major runtime upgrade.

### Production stability

Atlas avoids using Node 26 Current as the canonical production baseline before it enters LTS.

### Reproducible environments

Exact execution-version pinning reduces local and CI runtime drift.

### Controlled upgrades

Non-major Node 24 updates can be adopted as maintenance changes, while major upgrades receive explicit architectural review.

### Clear separation of concerns

The runtime decision does not silently determine Atlas's TypeScript build or execution strategy.

## Negative Consequences

### Node 24 becomes a repository convention

Atlas tooling and development environments are expected to support Node 24.x unless this ADR is superseded.

### Future major upgrade work

Atlas will eventually need to evaluate and potentially migrate to a newer Node major.

### Version-pin maintenance

The approved execution version must be deliberately updated and synchronized across local development, CI, and deployment configuration.

### Some newer runtime capabilities remain deferred

Atlas does not make Node 26-specific capabilities production assumptions while Node 26 remains outside the selected baseline.

# Deferred Decisions

The following remain outside the scope of ADR-006.

## 1. TypeScript Build Strategy

This ADR does not choose whether Atlas uses `tsc`, a bundler, a transpiler, Node runtime execution, or another build pipeline.

## 2. TypeScript Development Execution

The development command and runtime execution strategy remain separate decisions.

Node 24's native TypeScript support does not automatically establish the repository's development workflow.

## 3. Module Format

This ADR does not choose between ESM, CommonJS, or any detailed module-boundary policy.

## 4. Production Artifact Strategy

The way Atlas packages and deploys production JavaScript artifacts remains a separate build/deployment decision.

## 5. Deployment Platform

The production hosting platform and its Node runtime configuration are not selected by this ADR.

# Reconsideration Criteria

The runtime baseline should be reconsidered when a measurable problem, lifecycle event, or material compatibility requirement emerges.

Relevant triggers include:

- **Node 26 enters LTS:** formally reassess whether Node 26 should replace Node 24.
- **Dependency compatibility changes:** a critical Atlas dependency officially drops Node 24 or requires Node 26+.
- **Security:** a significant Node 24 security issue requires a major-version move or makes continued use impractical.
- **Platform support:** the selected deployment platform changes its supported Node runtime policy.
- **Required capability:** Atlas requires a runtime capability that cannot reasonably be supported on Node 24.
- **Operational cost:** maintaining Node 24 becomes materially more costly than upgrading.

A major-version review should evaluate:

- runtime compatibility;
- dependency compatibility;
- build and development tooling;
- test behavior;
- CI;
- deployment;
- security;
- migration effort;
- rollback strategy.

The default future review point is Node 26 entering LTS, not the mere existence of a newer Current release.

# Relationship to Other Decisions

This ADR establishes the runtime baseline used by:

[ADR-005 — Sprint 1 Testing Toolchain](ADR-005-sprint-1-testing-toolchain.md)

Repository and workspace structure are governed by:

[ADR-002 — Project Folder Structure](ADR-002-project-folder-structure.md)

Workspace and package-management decisions are governed by:

[ADR-003 — Workspace and Package Management Strategy](ADR-003-workspace-and-package-management-strategy.md)

Testing architecture is governed by:

[ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)

Documentation authority and lifecycle are governed by:

[Documentation Governance](../../governance/documentation-governance.md)

# Status

**Accepted**

Atlas adopts **Node.js 24.x** as its architectural runtime baseline, with **Node.js 24.19.0** as the initial approved exact execution version for reproducible local and CI execution.

Node 26 remains a future upgrade candidate and should be formally reassessed after it enters LTS and Atlas's dependency and tooling ecosystem officially supports or demonstrates compatibility with it.
