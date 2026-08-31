import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  contractChecks,
  parseRollbackPlanPath,
  rollbackSteps,
  validateRollbackPlan,
} from "./validate-rollback-plan.mjs";

const now = Date.parse("2026-08-31T15:00:00.000Z");

function release(version, revisionCharacter, digestCharacters) {
  return {
    version,
    revision: revisionCharacter.repeat(40),
    apiImageDigest: `sha256:${digestCharacters[0].repeat(64)}`,
    webImageDigest: `sha256:${digestCharacters[1].repeat(64)}`,
    metricsCollectorImageDigest: `sha256:${digestCharacters[2].repeat(64)}`,
  };
}

function createPlan({ baselineKind = "previous-release", outcome = "ready" } = {}) {
  const ready = outcome === "ready";
  const firstRelease = baselineKind === "first-release";
  return {
    schemaVersion: 1,
    planId: "rollback-2026-08-31-candidate-123",
    environment: "staging",
    candidate: release("1.2.3", "a", ["b", "c", "d"]),
    baseline: {
      kind: baselineKind,
      release: firstRelease ? null : release("1.2.2", "e", ["f", "1", "2"]),
      status: ready ? "verified" : "blocked",
      evidence: ready ? ["evidence://rollback/baseline"] : [],
    },
    database: {
      currentSchemaVersion: firstRelease
        ? "none"
        : "0015_create_administration_audit_foundation.sql",
      candidateSchemaVersion: firstRelease
        ? "0001_create_system_metadata.sql"
        : "0016_add_release_marker.sql",
      newMigrations: ready
        ? [
            {
              name: firstRelease
                ? "0001_create_system_metadata.sql"
                : "0016_add_release_marker.sql",
              checksum: "3".repeat(64),
              compatibility: firstRelease ? "not-applicable" : "backward-compatible",
              evidence: ["evidence://rollback/migration-review"],
            },
          ]
        : [],
      compatibilityDecision: ready
        ? firstRelease
          ? "not-applicable"
          : "previous-api-compatible"
        : "not-evaluated",
      rollbackAction: ready
        ? firstRelease
          ? "forward-fix-or-recover"
          : "retain-forward-schema"
        : "not-evaluated",
      recoveryPointEvidence: ready ? ["evidence://rollback/recovery-point"] : [],
      reviewedBy: ready ? "database-owner" : "replace-with-database-owner",
    },
    contracts: contractChecks.map((id) => ({
      id,
      status: ready ? (firstRelease ? "not-applicable" : "compatible") : "not-evaluated",
      notes: ready
        ? firstRelease
          ? "No previous client or API exists."
          : "Mixed-version transition is compatible."
        : "Compatibility has not been evaluated.",
      evidence: ready && !firstRelease ? [`evidence://rollback/contracts/${id}`] : [],
    })),
    procedure: {
      strategy: ready ? (firstRelease ? "remove-traffic" : "previous-release-set") : "blocked",
      rehearsed: ready,
      rehearsalEvidence: ready ? ["evidence://rollback/rehearsal"] : [],
      steps: rollbackSteps.map((id) => ({
        id,
        owner: ready ? "release-operator" : "replace-with-operator",
        instruction: ready
          ? `Execute reviewed ${id} procedure.`
          : `Example-only ${id} procedure is not ready.`,
      })),
    },
    decision: {
      outcome,
      decidedAt: "2026-08-31T13:00:00.000Z",
      decidedBy: ready ? "release-owner" : "replace-with-release-owner",
      reason: ready
        ? "The candidate has a rehearsed safe rollback boundary."
        : "Compatibility and rehearsal evidence are incomplete.",
    },
  };
}

describe("rollback plan validation", () => {
  it("keeps the committed example valid, blocked, and ineligible", () => {
    const example = JSON.parse(
      readFileSync(
        new URL("../../docs/engineering/rollback-plan.example.json", import.meta.url),
        "utf8",
      ),
    );

    const report = validateRollbackPlan(example, { now });
    assert.equal(report.outcome, "blocked");
    assert.equal(report.readinessEligible, false);
    assert.ok(report.blockingItems > 0);
  });

  it("accepts a rehearsed previous-release rollback as readiness-eligible", () => {
    const report = validateRollbackPlan(createPlan(), { now });

    assert.equal(report.baselineKind, "previous-release");
    assert.equal(report.strategy, "previous-release-set");
    assert.equal(report.blockingItems, 0);
    assert.equal(report.readinessEligible, true);
    assert.equal(report.expiresAt, "2026-09-07T13:00:00.000Z");
  });

  it("accepts first-release traffic removal without inventing a baseline", () => {
    const report = validateRollbackPlan(createPlan({ baselineKind: "first-release" }), { now });

    assert.equal(report.baselineKind, "first-release");
    assert.equal(report.strategy, "remove-traffic");
    assert.equal(report.readinessEligible, true);
  });

  it("accepts a blocked plan and expires an old ready plan", () => {
    const blocked = validateRollbackPlan(createPlan({ outcome: "blocked" }), { now });
    assert.equal(blocked.outcome, "blocked");
    assert.equal(blocked.readinessEligible, false);

    const expired = validateRollbackPlan(createPlan(), {
      now: Date.parse("2026-09-07T13:00:00.000Z"),
    });
    assert.equal(expired.outcome, "ready");
    assert.equal(expired.readinessEligible, false);
  });

  it("accepts direct Node and pnpm-forwarded paths", () => {
    assert.equal(parseRollbackPlanPath(["record.json"]), "record.json");
    assert.equal(parseRollbackPlanPath(["--", "record.json"]), "record.json");
    assert.throws(() => parseRollbackPlanPath([]), /Usage/);
    assert.throws(() => parseRollbackPlanPath(["one.json", "two.json"]), /Usage/);
  });

  it("requires immutable, distinct candidate and baseline identities", () => {
    const same = createPlan();
    same.baseline.release = structuredClone(same.candidate);
    assert.throws(() => validateRollbackPlan(same, { now }), /must differ/);

    const mutable = createPlan();
    mutable.baseline.release.apiImageDigest = "atlas-api:previous";
    assert.throws(() => validateRollbackPlan(mutable, { now }), /immutable SHA-256/);

    const placeholder = createPlan();
    placeholder.candidate.revision = "0".repeat(40);
    assert.throws(() => validateRollbackPlan(placeholder, { now }), /placeholder candidate/);
  });

  it("fails closed on database incompatibility and incomplete migration evidence", () => {
    const breaking = createPlan();
    breaking.database.newMigrations[0].compatibility = "breaking";
    breaking.database.newMigrations[0].evidence = [];
    assert.throws(() => validateRollbackPlan(breaking, { now }), /blocking rollback conditions/);

    const missingMigrations = createPlan();
    missingMigrations.database.newMigrations = [];
    assert.throws(
      () => validateRollbackPlan(missingMigrations, { now }),
      /must list its new migrations/,
    );

    const wrongFinalMigration = createPlan();
    wrongFinalMigration.database.newMigrations[0].name = "0017_wrong_final.sql";
    assert.throws(() => validateRollbackPlan(wrongFinalMigration, { now }), /final new migration/);
  });

  it("requires complete transition-contract evidence", () => {
    const missing = createPlan();
    missing.contracts.pop();
    assert.throws(() => validateRollbackPlan(missing, { now }), /Missing contract checks/);

    const incompatible = createPlan();
    incompatible.contracts[1].status = "incompatible";
    incompatible.contracts[1].evidence = [];
    assert.throws(
      () => validateRollbackPlan(incompatible, { now }),
      /blocking rollback conditions/,
    );

    const firstReleaseClaim = createPlan({ baselineKind: "first-release" });
    firstReleaseClaim.contracts[0].status = "compatible";
    firstReleaseClaim.contracts[0].evidence = ["evidence://rollback/fictional-baseline"];
    assert.throws(
      () => validateRollbackPlan(firstReleaseClaim, { now }),
      /blocking rollback conditions/,
    );
  });

  it("requires an ordered, complete, rehearsed operator procedure", () => {
    const unordered = createPlan();
    [unordered.procedure.steps[0], unordered.procedure.steps[1]] = [
      unordered.procedure.steps[1],
      unordered.procedure.steps[0],
    ];
    assert.throws(() => validateRollbackPlan(unordered, { now }), /required order/);

    const unrehearsed = createPlan();
    unrehearsed.procedure.rehearsed = false;
    unrehearsed.procedure.rehearsalEvidence = [];
    assert.throws(() => validateRollbackPlan(unrehearsed, { now }), /must be rehearsed/);
  });

  it("rejects a blocked decision with no real blocker", () => {
    const plan = createPlan();
    plan.decision.outcome = "blocked";
    assert.throws(() => validateRollbackPlan(plan, { now }), /at least one blocking/);
  });

  it("rejects unknown fields, future decisions, and likely secrets", () => {
    const unknown = createPlan();
    unknown.reverseMigrations = true;
    assert.throws(() => validateRollbackPlan(unknown, { now }), /must contain exactly/);

    const future = createPlan();
    future.decision.decidedAt = "2026-08-31T16:00:00.000Z";
    assert.throws(() => validateRollbackPlan(future, { now }), /cannot be in the future/);

    const secret = createPlan();
    secret.procedure.steps[0].instruction = "Authorization: Bearer super-sensitive-value";
    assert.throws(() => validateRollbackPlan(secret, { now }), /secret material/);
  });
});
