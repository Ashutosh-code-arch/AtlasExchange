import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  parseReadinessRecordPath,
  readinessControls,
  validateReadinessRecord,
} from "./validate-readiness-record.mjs";

function createRecord({ outcome = "go", status = "passed" } = {}) {
  return {
    schemaVersion: 1,
    environment: "production",
    release: {
      version: "1.2.3",
      revision: "a".repeat(40),
      apiImageDigest: `sha256:${"b".repeat(64)}`,
      webImageDigest: `sha256:${"c".repeat(64)}`,
    },
    decision: {
      outcome,
      decidedAt: "2026-08-31T12:00:00.000Z",
      decidedBy: "release-owner",
      reason: outcome === "go" ? "All required evidence passed." : "A required control is blocked.",
    },
    controls: readinessControls.map((control) =>
      status === "passed"
        ? {
            id: control.id,
            status,
            observedAt: "2026-08-31T11:00:00.000Z",
            expiresAt: "2026-09-01T11:00:00.000Z",
            evidence: [`evidence://${control.id}`],
          }
        : {
            id: control.id,
            status,
            notes: "Evidence has not been collected.",
          },
    ),
  };
}

describe("production readiness record validation", () => {
  it("keeps the committed example valid and explicitly no-go", () => {
    const example = JSON.parse(
      readFileSync(
        new URL("../../docs/engineering/production-readiness-record.example.json", import.meta.url),
        "utf8",
      ),
    );

    const report = validateReadinessRecord(example);
    assert.equal(report.outcome, "no-go");
    assert.equal(report.passedControls, 0);
  });

  it("accepts direct Node and pnpm-forwarded record paths", () => {
    assert.equal(parseReadinessRecordPath(["record.json"]), "record.json");
    assert.equal(parseReadinessRecordPath(["--", "record.json"]), "record.json");
    assert.throws(() => parseReadinessRecordPath([]), /Usage/);
    assert.throws(() => parseReadinessRecordPath(["--", "one.json", "two.json"]), /Usage/);
  });

  it("accepts a go only when every required control has fresh evidence", () => {
    const report = validateReadinessRecord(createRecord());

    assert.equal(report.outcome, "go");
    assert.equal(report.passedControls, readinessControls.length);
    assert.deepEqual(report.blockingControls, []);
  });

  it("accepts an explicit no-go record while preserving every visible gap", () => {
    const report = validateReadinessRecord(
      createRecord({ outcome: "no-go", status: "not-evaluated" }),
    );

    assert.equal(report.outcome, "no-go");
    assert.equal(report.passedControls, 0);
    assert.deepEqual(
      report.blockingControls,
      readinessControls.map((control) => control.id),
    );
  });

  it("rejects go when any control is blocked", () => {
    const record = createRecord();
    record.controls[3] = {
      id: record.controls[3].id,
      status: "blocked",
      notes: "Alert delivery has not been proven.",
    };

    assert.throws(() => validateReadinessRecord(record), /go decision cannot contain blocking/);
  });

  it("rejects missing, duplicate, and unknown controls", () => {
    const missing = createRecord();
    missing.controls.pop();
    assert.throws(() => validateReadinessRecord(missing), /Missing readiness controls/);

    const duplicate = createRecord();
    duplicate.controls[1].id = duplicate.controls[0].id;
    assert.throws(() => validateReadinessRecord(duplicate), /Duplicate readiness control/);

    const unknown = createRecord();
    unknown.controls[0].id = "vendor-dashboard-green";
    assert.throws(() => validateReadinessRecord(unknown), /Unknown readiness control/);
  });

  it("rejects absent, future, expired, and overlong evidence", () => {
    const absent = createRecord();
    absent.controls[0].evidence = [];
    assert.throws(() => validateReadinessRecord(absent), /at least one reference/);

    const future = createRecord();
    future.controls[0].observedAt = "2026-08-31T13:00:00.000Z";
    assert.throws(() => validateReadinessRecord(future), /after the decision/);

    const expired = createRecord();
    expired.controls[0].expiresAt = "2026-08-31T12:00:00.000Z";
    assert.throws(() => validateReadinessRecord(expired), /expired/);

    const overlong = createRecord();
    overlong.controls.find((control) => control.id === "synthetic-smoke-tests").expiresAt =
      "2026-09-02T11:00:00.001Z";
    assert.throws(() => validateReadinessRecord(overlong), /1-day freshness policy/);
  });

  it("rejects mutable or incomplete release identity", () => {
    const invalidVersion = createRecord();
    invalidVersion.release.version = "v1.2.3";
    assert.throws(() => validateReadinessRecord(invalidVersion), /MAJOR\.MINOR\.PATCH/);

    const invalidRevision = createRecord();
    invalidRevision.release.revision = "main";
    assert.throws(() => validateReadinessRecord(invalidRevision), /full lowercase Git commit/);

    const invalidDigest = createRecord();
    invalidDigest.release.apiImageDigest = "atlas-api:latest";
    assert.throws(() => validateReadinessRecord(invalidDigest), /immutable SHA-256/);
  });

  it("rejects ambiguous decision metadata and local targets", () => {
    const invalidOutcome = createRecord();
    invalidOutcome.decision.outcome = "approved";
    assert.throws(() => validateReadinessRecord(invalidOutcome), /either "go" or "no-go"/);

    const invalidEnvironment = createRecord();
    invalidEnvironment.environment = "local";
    assert.throws(() => validateReadinessRecord(invalidEnvironment), /staging or production/);

    const nonUtcDecision = createRecord();
    nonUtcDecision.decision.decidedAt = "2026-08-31T17:30:00+05:30";
    assert.throws(() => validateReadinessRecord(nonUtcDecision), /ISO-8601 UTC timestamp/);

    const impossibleDecision = createRecord();
    impossibleDecision.decision.decidedAt = "2026-02-31T12:00:00.000Z";
    assert.throws(() => validateReadinessRecord(impossibleDecision), /ISO-8601 UTC timestamp/);
  });
});
