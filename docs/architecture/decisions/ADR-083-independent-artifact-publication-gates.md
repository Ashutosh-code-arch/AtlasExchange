# ADR-083: Independent Artifact Publication Gates

**Classification:** Canonical

**Status:** Accepted

**Date:** 2026-09-04

**Last reviewed:** 2026-09-04

**Canonical owner/source:** ADR-083

## Context

The v0.2.2 candidate API passes the High/Critical image gate, but the separately built Alloy
metrics collector contains a High-severity gRPC dependency finding. The owner approved independent
artifact publication instead of suppressing that finding or maintaining a custom Alloy build.

This decision supersedes only the coupled publication trigger/artifact gating portions of
ADR-063 and ADR-065. It does not change deployment, compatibility, rollback, or vulnerability
exception approval requirements.

## Decision

- A published stable GitHub Release establishes source identity. Image publication requires an
  explicit workflow dispatch selecting `api`, `web`, `metrics-collector`, or `all` for that tag.
- Retain one version and source commit. Require tag/package-version agreement, the exact tagged
  checkout, ancestry from `origin/main`, and an existing non-draft, non-prerelease GitHub Release.
- Shared preparation retains frozen installation, source-secret scanning, the live workspace
  dependency audit, migrations, verification, and production builds. Shared failures block all
  selected artifacts.
- Each selected image builds and scans both AMD64 and ARM64 runtime variants with the pinned
  scanner and fresh advisory data before registry login/publication. Scanner errors and
  High/Critical findings fail that artifact; matrix fail-fast is disabled, not security failure.
- The publishing job has narrowly scoped registry/attestation permissions; registry login and
  all push/sign steps occur only after its image scans succeed. No continue-on-error or new
  vulnerability exception is introduced.
- Keep digest-pinned bases, source/version labels, multi-platform images, SBOMs, and signed
  provenance. Reuse the BuildKit results of the scanned builds for publication.
- No-argument local build/scan commands and the repository-wide quality workflow still cover
  every image. An API-only release is not a passing whole-repository security assessment.
- Release notes identify selected, published, failed, or omitted artifacts. A GitHub Release
  alone is not proof of image availability; require the successful job and attested digest.
- This changes publication only. Never deploy an affected collector or enable signup as an
  implied consequence. Production-shaped deployment still needs its complete approved set.

## Consequences

An unrelated collector finding no longer blocks an otherwise verified API artifact. Partial
artifact availability is now explicit and must be checked by operators. The collector stays blocked
until a patched upstream image passes scanning, or a separately approved remediation is implemented.
Scanning both architectures adds build time. Maintaining a forked Alloy or accepting this new
vulnerability without exposure analysis is not part of this decision.

See the [release runbook](../../engineering/release-and-deployment.md).
