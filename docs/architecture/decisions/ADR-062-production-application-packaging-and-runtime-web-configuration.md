# ADR-062 — Production Application Packaging and Runtime Web Configuration

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-30  
**Last reviewed:** 2026-08-30  
**Canonical owner/source:** ADR-062

## Context

Atlas builds two independently runnable applications from one repository: an Express API and a
React/Vite web client. Local development intentionally runs application processes natively, while
PostgreSQL and Mailpit use containers. That development choice does not yet define reproducible,
least-privilege production artifacts.

Vite environment values are normally embedded while browser assets are built. Baking an API URL
into the bundle would require rebuilding the web artifact for every environment and would make image
promotion unreliable. Conversely, browser-visible runtime configuration cannot contain secrets and
must not weaken the API's authoritative origin, cookie, or CSRF checks.

The API also needs its compiled migration entry point and committed migration history in production,
without running migrations automatically when every API replica starts.

## Decision Drivers

The production packaging boundary should:

1. produce separate API and web images from the monorepo;
2. use the accepted exact Node.js and pnpm baselines during builds;
3. install only the API's production dependency graph in its runtime image;
4. run both application processes as an unprivileged user;
5. promote one web image through environments without rebuilding assets;
6. make all browser runtime configuration explicitly public and validated;
7. keep migrations separate from API process startup;
8. provide container-native liveness checks and deterministic CI builds; and
9. avoid selecting a registry, orchestrator, TLS edge, or production database prematurely.

# Decision

Atlas will build two independent, multi-stage OCI-compatible container images:

```text
one Git repository
├── atlas-api image  → API deployment
└── atlas-web image  → web deployment
```

Container packaging is a deployment boundary, not a microservice split. Module ownership and
cross-module access remain governed by ADR-008.

## 1. Reproducible build baseline

Both Dockerfiles use the exact accepted `node:24.19.0-bookworm-slim` base and activate pnpm
`11.20.0` only in the build stage. Installation uses the committed root lockfile with
`--frozen-lockfile`.

pnpm injected workspace dependencies and post-build synchronization allow `pnpm deploy --prod` to
materialize the API's declared production graph. The runtime image does not depend on monorepo
symlinks, root development tools, or another workspace's installation.

The Debian slim variant is preferred over Alpine initially because Atlas uses native Node modules
and has no measured size requirement that justifies another libc boundary.

## 2. API runtime image

The API runtime image contains only:

- its production `package.json` and production dependency tree;
- compiled JavaScript and source maps;
- committed PostgreSQL migrations; and
- runtime resources such as the compromised-password corpus.

It excludes TypeScript source, test dependencies, repository tooling, documentation, and local
environment files. The process runs as the base image's unprivileged `node` user, listens on port
`3000`, and uses `/health/live` for the image health check.

The same image exposes the compiled migration entry point at
`dist/platform/database/migrate.js`. A deployment runs it with Node as a separate, controlled step
before advancing application replicas. The runtime image intentionally contains no package manager.
API startup never applies or pushes schema changes automatically, preserving ADR-010's migration
ownership and concurrency rule.

Readiness remains an external traffic-routing signal. The image health check deliberately uses
liveness so a temporary database outage does not create an automatic restart loop.

## 3. Immutable web artifact and runtime configuration

Vite produces content-hashed browser assets once. The web runtime image contains that build output
and a dependency-free Node static server; it contains no package manager or application dependency
tree.

At process startup the server requires:

```text
ATLAS_WEB_API_BASE_URL=https://api.example.test
```

It validates an HTTP(S) URL without credentials, query, or fragment and serves it through the
non-cacheable `/runtime-config.js` document. The document assigns an immutable public configuration
object before the application module executes. Browser code parses the object through the existing
strict runtime schema.

`ATLAS_WEB_API_BASE_URL` is public configuration, never a secret. The web artifact must not receive
database credentials, session secrets, metrics tokens, or other server authority. API CORS,
credential, cookie, and CSRF configuration remains independently validated and authoritative.

The server accepts `PORT`, then `ATLAS_WEB_PORT`, and otherwise listens on `8080`. It provides:

- `/health/live` with no-store caching;
- immutable one-year caching for content-hashed `/assets/` files;
- no-cache HTML and SPA route fallback;
- no-store runtime configuration;
- explicit MIME types and GET/HEAD-only static delivery; and
- browser security headers, including a CSP whose connection sources are derived from the validated
  API origin.

TLS termination, compression, CDN behavior, and public ingress remain responsibilities of the
future deployment edge.

## 4. Runtime constraints

Both final images run as the unprivileged `node` user and write no application state into the image
filesystem. Secrets and environment-specific configuration are supplied by the runtime, not copied
into an image or build argument.

The Docker build context excludes Git metadata, environment files, tests, coverage, documentation,
and local build outputs. A future platform should also enforce read-only roots, dropped Linux
capabilities, resource requests/limits, and an appropriate seccomp profile where supported.

## 5. Tags, promotion, and verification

Local builds use:

```text
atlas-api:local
atlas-web:local
```

`pnpm containers:build` builds both images. CI performs this build after the repository quality and
artifact gates. Static-server tests verify validation, escaping, caching, headers, SPA fallback,
method restrictions, and liveness.

Production publishing must assign immutable source-derived metadata and deploy by immutable digest.
The source Dockerfiles currently pin exact version tags rather than platform-specific digests because
the registry and multi-architecture publication pipeline are not yet selected. That selection must
define digest maintenance and provenance before production release.

## Alternatives Considered

### Embed the API URL at Vite build time

Rejected because each environment would need a distinct web build and image. This weakens immutable
artifact promotion and makes configuration drift harder to diagnose.

### Serve the web bundle from the API process

Rejected because it collapses two deployment boundaries, couples asset delivery to API scaling, and
prevents independent web rollout without providing a present operational benefit.

### Use nginx for the web image

Credible, but deferred. The required static behavior is small and can use the already-pinned Node
runtime without another server configuration language and image lifecycle. Reconsider nginx, a CDN,
or object storage when measured traffic or edge requirements justify it.

### Run migrations during API startup

Rejected because concurrent replicas can race, rollout failures become ambiguous, and schema change
authority is hidden inside ordinary process startup.

### Copy the complete monorepo installation into the API image

Rejected because it includes unrelated and development-only dependencies, obscures production
dependency ownership, and increases artifact size and attack surface.

## Consequences

### Positive Consequences

- API and web deployments can scale and release independently from one repository.
- One web image can be promoted through environments with runtime-selected public API configuration.
- The API runtime dependency tree is derived from its explicit workspace manifest.
- Images contain no local environment files and run without root privileges.
- Migration execution remains explicit and uses the same compiled application artifact.
- CI proves both production packaging paths remain buildable.

### Negative Consequences

- Docker builds repeat dependency installation in addition to ordinary CI installation.
- pnpm injected workspace dependencies add workspace configuration and synchronization behavior.
- Atlas owns a small production static server and must maintain its security and caching behavior.
- Node remains present in the web runtime even though the browser bundle itself is static.
- Exact base-image digest pinning and published image provenance remain unresolved.

## Reconsider When

Review this decision when Atlas selects a registry or deployment platform, publishes multi-architecture
images, needs signed provenance or SBOM policy, adopts a CDN or object storage, observes material web
serving load, requires a platform-specific process contract, changes the Node baseline, or splits the
projection worker from the command API.

## Related Decisions

- [ADR-003 — Workspace and Package-Management Strategy](ADR-003-workspace-and-package-management-strategy.md)
- [ADR-006 — Node.js Runtime Baseline](ADR-006-nodejs-runtime-baseline.md)
- [ADR-007 — TypeScript Module, Execution, and Build Strategy](ADR-007-typescript-module-execution-and-build-strategy.md)
- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-009 — Frontend Application Architecture](ADR-009-frontend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-012 — Configuration, Environment, and Secrets Strategy](ADR-012-configuration-environment-and-secrets-strategy.md)
- [ADR-015 — API Health, Readiness, and Process Lifecycle Strategy](ADR-015-api-health-readiness-and-process-lifecycle-strategy.md)
- [ADR-016 — Continuous Integration and Quality Gate Strategy](ADR-016-continuous-integration-and-quality-gate-strategy.md)
- [ADR-056 — Production HTTP Edge Security and Resource Boundary](ADR-056-production-http-edge-security-and-resource-boundary.md)
