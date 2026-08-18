# ADR-012 — Configuration, Environment, and Secrets Strategy

**Classification:** Canonical  
**Status:** Proposed  
**Date:** 2026-08-18  
**Last reviewed:** 2026-08-18  
**Canonical owner/source:** ADR-012

## 1. Context

Atlas requires configuration for API ports and URLs, PostgreSQL connections and pool settings, logging, authentication secrets, browser-visible API endpoints, test infrastructure, and future services.

Without a defined boundary, configuration can become scattered `process.env` access, fail only at request time, treat strings such as `"false"` incorrectly, leak secrets into browser bundles, or make tests depend on a developer's local environment.

The strategy therefore separates API and web configuration, validates configuration at startup/build time, and prevents application modules from directly depending on global environment state.

## 2. Decision

Atlas adopts independently owned configuration boundaries for the API and web applications.

### API configuration

The lifecycle is:

```text
process environment
        ↓
select declared variables
        ↓
validate and convert
        ↓
immutable typed configuration
        ↓
composition root
        ↓
module-specific configuration slices
```

Only the API configuration/bootstrap boundary may directly read `process.env`.

Application modules receive typed configuration or relevant immutable slices such as:

- `DatabaseConfig`
- `HttpConfig`
- `LoggingConfig`

Modules must not independently read environment variables.

Configuration is loaded and validated once during process startup. Atlas does not dynamically re-read environment variables during execution. A configuration change requires the appropriate process restart.

### Frontend configuration

The frontend has a separate build-time configuration boundary.

```text
environment values
        ↓
Vite build/dev
        ↓
validated immutable frontend configuration
        ↓
browser bundle
```

Only the frontend configuration boundary may directly read `import.meta.env`.

It selects declared public variables, validates and converts them once, and exposes an immutable typed frontend configuration object. Components, hooks, pages, and features must not independently read `import.meta.env`.

Invalid frontend configuration must fail Vite development startup or the production build rather than produce a bundle with invalid configuration.

Browser configuration is public and untrusted. Backend authentication, authorization, and financial decisions must never trust a `VITE_*` value.

### 2.1 API configuration loading and validation

Loading and validation are separate responsibilities:

```text
Environment loader
→ supplies strings through process.env

Configuration validator
→ validates, converts, and produces typed values
```

Atlas prefers launcher-level Node options such as `--env-file` or `--env-file-if-exists` for local API commands. Application source does not call `process.loadEnvFile()` during normal startup. The configuration module validates `process.env` without assuming how the values were supplied.

A general runtime-schema library is preferred for configuration validation, likely using the same library selected for API contracts, unless implementation reveals a concrete need for a specialized package.

Before the API starts listening, required values, URLs, ports, supported enums, production security requirements, and incompatible combinations must be validated.

Invalid configuration must terminate startup with a useful error. The error may identify the variable name and failed requirement but must never print the secret value.

### 2.2 Configuration precedence

For the API, configuration precedence is:

1. explicitly injected process environment from CI, deployment, or shell;
2. an optional workspace-local environment file used by development commands;
3. safe application defaults.

A lower-priority source must not overwrite an explicitly injected value.

Production must not depend on repository-local environment files. Security-sensitive production values must not receive application defaults.

Vite retains its documented precedence rules, but Atlas should avoid duplicating the same variable across several files without a clear reason.

### 2.3 Frontend public configuration

Vite `VITE_*` values are public because they are embedded in the browser bundle.

Safe examples include:

```text
VITE_API_BASE_URL
```

Unsafe examples include:

```text
VITE_DATABASE_URL
VITE_JWT_SECRET
VITE_PRIVATE_API_KEY
```

Changing the prefix does not make a value secret.

The initial strategy is build-time frontend configuration. Runtime browser configuration, such as a fetched `/config.json`, may be reconsidered if Atlas later requires one immutable frontend artifact to be promoted unchanged across multiple environments.

## 3. Environment taxonomy

Atlas distinguishes three concepts:

```text
NODE_ENV
→ Node/library execution mode
→ development | test | production

Vite mode
→ Vite file/build selection

ATLAS_ENV
→ deployment identity
→ local | test | ci | staging | production
```

These concepts must not be conflated. For example, staging normally uses:

```text
NODE_ENV=production
ATLAS_ENV=staging
```

Whether `ATLAS_ENV` is required during Sprint 1 remains an implementation decision.

## 4. Environment-file policy

Workspace-owned examples are:

```text
apps/api/.env.example
apps/web/.env.example
```

Actual local values remain ignored.

The repository policy is equivalent to:

```gitignore
.env
.env.*
!.env.example
!.env.*.example
```

The exact patterns must be tested against both workspace paths.

Only explicitly named example files may be committed. Before adding any new environment file, its tracking status and contents must be reviewed.

Rules:

- no real secrets are committed;
- examples contain safe placeholders;
- every documented variable explains its purpose and whether it is required;
- API secrets never appear in the web example;
- tests receive deterministic configuration from test setup;
- tests do not silently load the developer's local environment;
- automated secret scanning should be introduced in CI later.

A root environment file must not become an unstructured mixture of web, API, Compose, and deployment configuration.

## 5. Defaults

Defaults are permitted only when they are safe and unsurprising.

Example:

```text
LOG_LEVEL=debug
```

Security-sensitive production values must be explicit.

An authentication secret must never fall back to a development value in production.

## 6. Secret handling

Sprint 1 does not require a production secret manager, but the configuration boundary must remain compatible with one.

```text
Local development → ignored environment file
CI                → protected CI secret
Production        → deployment secret mechanism
Application       → environment/configuration object
```

Application code must not depend on which external mechanism supplied the value.

Secrets must not appear in:

- Git;
- browser bundles;
- logs;
- startup-error values;
- health responses;
- test snapshots;
- thrown configuration objects.

The complete configuration object must never be logged or serialized.

Validation errors may reveal the variable name and failed requirement, but never its raw value.

Sensitive configuration must be registered with the logging system's redaction policy when logging is introduced.

Secret values must not be included in exception metadata.

## 7. Configuration ownership and dependency rules

The configuration boundary is part of the composition root.

```text
configuration/bootstrap
        ↓
typed immutable configuration
        ↓
composition root
        ↓
application/module configuration slices
```

Modules receive only the configuration they need. They must not import the global configuration object merely for convenience when a narrower slice is sufficient.

Configuration must not contain business behavior.

## 8. Testing

Tests must use deterministic, explicitly controlled configuration.

Test setup must not silently consume a developer's `.env` or production environment values.

Configuration validation itself should be tested for:

- missing required variables;
- invalid types;
- invalid URLs;
- invalid ports;
- unsupported enum values;
- invalid combinations;
- production security requirements;
- safe error redaction.

Frontend configuration validation must be exercised during development/build verification.

## 9. Deferred decisions

The following remain intentionally deferred:

- exact runtime-schema library;
- exact API environment-file launcher scripts;
- whether `ATLAS_ENV` is required in Sprint 1;
- runtime browser configuration;
- production secret-manager selection;
- automated CI secret-scanning implementation;
- exact configuration variable inventory beyond the currently required values.

## 10. Consequences

### Positive

- Configuration is validated before application work begins.
- Modules do not depend on global process state.
- API secrets remain server-side.
- Frontend configuration is explicitly treated as public.
- Tests can be deterministic and isolated.
- A future secret manager can replace the source of values without changing application modules.
- Configuration ownership is visible and enforceable.

### Negative

- Each application has a separate configuration boundary.
- Configuration schemas require maintenance.
- Build-time frontend configuration can require separate artifacts per environment.
- Launcher-level environment-file handling must be documented.
- Configuration validation adds startup/build work.

## 11. Related decisions

- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-006 — Node.js Runtime Baseline](ADR-006-nodejs-runtime-baseline.md)
- [ADR-007 — TypeScript Module, Execution, and Build Strategy](ADR-007-typescript-module-execution-and-build-strategy.md)
- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-009 — Frontend Application Architecture](ADR-009-frontend-application-architecture.md)
- [ADR-011 — PostgreSQL Runtime and Local Development Strategy](ADR-011-postgresql-runtime-and-local-development-strategy.md)

## 12. References

- [Node.js environment-variable documentation](https://nodejs.org/api/environment_variables.html)
- [Vite environment and mode documentation](https://vite.dev/guide/env-and-mode.html)

## Status summary

**Status: Proposed**

ADR-012 is ready for acceptance after the referenced ADR chain exists in the repository and all related links resolve.
