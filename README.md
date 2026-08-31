# Atlas Exchange

Atlas Exchange is a production-inspired centralized-exchange learning platform. The repository is
being delivered incrementally so every phase leaves behind a runnable, tested system.

## Current delivery state: Phase 7 complete

The implemented Atlas learning platform provides:

- a pnpm TypeScript monorepo;
- a light, responsive React/Vite exchange interface;
- an Express API with validated configuration, structured logging, request correlation, bounded
  resources, rate limiting, health/readiness, and protected metrics;
- PostgreSQL migrations, explicit transaction ownership, exact Financial invariants, capacity
  controls, and isolated recovery validation;
- shared runtime contracts;
- lint, formatting, type-check, unit/integration/component/E2E tests, production builds, Docker
  Compose, and CI quality gates;
- registration, email verification, authentication, rotating sessions, password recovery, roles,
  and account/session surfaces;
- exact asset quantities, owner-scoped wallets, append-only double-entry journals, authoritative
  balances, and retry-safe simulated deposits and withdrawals;
- exact spot limit orders, durable reservation, deterministic price-time matching, immutable trades,
  atomic four-wallet settlement, owner-scoped history, and an exchange-style Trading desk;
- durable level-two, ticker, and candle projections delivered through REST and WebSocket boundaries;
- owner-scoped portfolio valuation, durable Notifications, and audited Administration surfaces; and
- non-root production images, immutable release identity, recovery/security gates, operational
  runbooks, and a machine-validated production go/no-go record.

Atlas remains a simulated centralized-exchange learning platform. Phase 7 completion means its
production-readiness controls are defined and tested; it does **not** mean production traffic, real
custody, external market execution, regulatory approval, or a production hosting environment has
been approved.

Phase 8 has selected Render as the initial production-shaped staging target and Cloudflare Access as
its deny-by-default sharing boundary. Both deployables enforce the signed staging assertion at their
Render origins. Grafana Alloy and Grafana Cloud now define the private metrics, dashboard, alert, and
external-readiness boundary, including an immutable collector image and validated operational
configuration. A deterministic generator now produces the release-specific Render Blueprint only
from exact external inputs, fresh candidate evidence, and an unexpired cost approval. Live cost
approval, an owned domain, exact invited identities, provider accounts, a generated and validated
manifest, and verified proxy semantics remain required. An opt-in read-only staging suite is ready
to validate a deployed candidate and emit sanitized partial smoke evidence without mutating business
state. A strict incident-exercise record now preserves response roles, timing, recovery proof,
contact-path results, and corrective actions without pretending a repository test performed the
exercise. The initial product-scope contract now limits any approval to invited testers and
simulated-only value, with release-bound deployment, disclosure, privacy, and tested-support
evidence. A strict rollback-plan contract now distinguishes a verified previous release from the
first-release remove-traffic fallback and prohibits reverse-migration shortcuts. No provider
resource, domain, production environment, live exercise, product approval, or rollback rehearsal
has been created. Release `v0.1.1` is the first complete staging candidate: its API, web, and
metrics-collector images are published for AMD64/ARM64, signed, SBOM-attached, anonymously pullable,
and recorded by immutable digest. Publication is artifact evidence only and does not change the
staging or production `no-go` decision.

## Prerequisites

- Node.js `24.19.0` (the exact version is enforced by `package.json`)
- pnpm `11.20.0`
- Docker with Compose

## Start locally

```bash
corepack enable
pnpm install
pnpm --filter @atlas/e2e exec playwright install chromium
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
pnpm db:up
pnpm mail:up
pnpm db:migrate
pnpm dev
```

The web application runs at `http://localhost:5173`, the API at `http://localhost:3000`, and the
Mailpit inbox at `http://localhost:8025`.
Set `ATLAS_POSTGRES_PORT` before `pnpm db:up` when host port `5432` is already in use.

## Commands

```bash
pnpm dev            # run API and web development servers
pnpm db:up          # start the local PostgreSQL container
pnpm mail:up        # start the local SMTP capture inbox
pnpm db:migrate     # apply committed migrations
pnpm db:recovery:drill:local # prove an isolated local dump/restore and financial validation
pnpm verify         # typecheck, lint, format-check, and test
pnpm test:e2e       # run the isolated full-stack browser journeys
pnpm test:staging   # run opt-in read-only checks against an exact deployed staging candidate
pnpm build          # create production artifacts
pnpm containers:build # build the API, web, and metrics-collector images
pnpm observability:validate # validate the staging dashboard and alert policy
pnpm security:secrets # scan source-control candidates without printing credential values
pnpm security:dependencies # fail on High/Critical workspace advisories
pnpm security:containers # fail on High/Critical findings in all built images
pnpm security:check # run all security checks; expects all local images to exist
pnpm readiness:validate -- <record.json> # validate a staging/production go-no-go record
pnpm incident:exercise:validate -- <record.json> # validate a timed response exercise record
pnpm product:scope:validate -- <record.json> # validate an initial product-scope approval
pnpm rollback:validate -- <record.json> # validate a candidate-bound rollback plan
pnpm staging:render:generate -- --config <input.json> --readiness <record.json> --output <render.yaml>
```

Production images are built independently as `atlas-api:local`, `atlas-web:local`, and
`atlas-metrics-collector:local`. The web image
requires the public `ATLAS_WEB_API_BASE_URL` at startup, so one immutable image can be promoted
between environments without rebuilding browser assets. The API image exposes its migration runner
at `node --enable-source-maps dist/platform/database/migrate.js`; migrations remain a separate
deployment step and never run implicitly at API startup. See
[ADR-062](docs/architecture/decisions/ADR-062-production-application-packaging-and-runtime-web-configuration.md)
for the complete packaging boundary.

Stable published GitHub Releases produce signed, SBOM-attached AMD64/ARM64 images in GHCR. Releases
must use `vMAJOR.MINOR.PATCH`, match the root package version, and point to `main`; environments
promote the resulting API, web, and collector digests rather than mutable tags. See the
[release and deployment runbook](docs/engineering/release-and-deployment.md).

CI and stable-release preparation scan source-control candidates for likely credentials, audit the
complete workspace graph, and scan all built runtime images with a digest-pinned least-authority
scanner. High or Critical findings block publication. The security evidence is deliberately
separate from deterministic `pnpm verify`; see
[ADR-065](docs/architecture/decisions/ADR-065-software-supply-chain-vulnerability-and-secret-response.md).

PostgreSQL recovery requires managed point-in-time recovery plus separately encrypted portable
archives; creating a backup is not accepted as proof until an isolated restore passes migration and
Financial invariant validation. The local recovery command restores only into a generated
`atlas_recovery_drill_*` database and deletes its temporary archive. See the
[database recovery runbook](docs/engineering/database-recovery.md).

Production traffic requires an explicit candidate-bound go/no-go record covering all runtime,
recovery, security, capacity, monitoring, rollback, incident-response, and product-scope controls.
The committed example is deliberately `no-go`; repository checks or image publication alone never
approve production. See the
[operational readiness and incident runbook](docs/engineering/operational-readiness.md).
The [incident-response exercise runbook](docs/engineering/incident-response-exercise.md) defines the
separate timed drill and restricted evidence required for that readiness control.
The [product-scope approval runbook](docs/engineering/product-scope-approval.md) defines the separate
release-bound product, privacy, disclosure, and support review.
The [rollback planning runbook](docs/engineering/rollback-planning.md) defines forward-schema
compatibility, first-release traffic removal, and rehearsal evidence.

The E2E command provisions its own ephemeral PostgreSQL and Mailpit services through Docker
Compose, starts the API and web application on available ports, and removes the test services when
the run finishes. It does not reuse or modify the normal local-development database.

See [Phase delivery](docs/engineering/phase-delivery.md) for scope and completion criteria.
