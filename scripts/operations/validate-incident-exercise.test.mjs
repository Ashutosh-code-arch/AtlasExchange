import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  exerciseObjectives,
  parseIncidentExerciseRecordPath,
  participantRoles,
  timelineEvents,
  validateIncidentExerciseRecord,
} from "./validate-incident-exercise.mjs";

const now = Date.parse("2026-08-31T15:00:00.000Z");

function createRecord({ outcome = "passed" } = {}) {
  const failed = outcome === "failed";
  return {
    schemaVersion: 1,
    exerciseId: "irx-2026-08-31-service-outage-01",
    mode: "tabletop",
    environment: "staging",
    scenario: {
      type: "service-outage",
      expectedSeverity: "SEV-2",
      title: "Synthetic API readiness outage",
    },
    runbook: {
      reference: "docs/engineering/operational-readiness.md",
      revision: "a".repeat(40),
    },
    contactPath: {
      reference: "evidence://incident-exercise/contact-path",
      tested: true,
      result: failed ? "failed" : "passed",
    },
    timing: {
      startedAt: "2026-08-31T12:00:00.000Z",
      endedAt: "2026-08-31T13:00:00.000Z",
    },
    participants: participantRoles.map((role) => ({ role, operator: "solo-operator" })),
    objectives: exerciseObjectives.map((id) => ({
      id,
      status: failed && id === "communicate-status" ? "failed" : "passed",
      notes:
        failed && id === "communicate-status" ? "Contact path did not deliver." : "Objective met.",
      evidence: failed && id === "communicate-status" ? [] : [`evidence://incident-exercise/${id}`],
    })),
    timeline: timelineEvents.map((event, index) => ({
      at: `2026-08-31T12:${String(index * 10).padStart(2, "0")}:00.000Z`,
      event,
      actor: "solo-operator",
      summary: `Completed synthetic ${event}.`,
      evidence: event === "recovery-validation" ? ["evidence://incident-exercise/recovery"] : [],
    })),
    correctiveActions: failed
      ? [
          {
            id: "IRX-1",
            severity: "high",
            status: "open",
            owner: "solo-operator",
            dueAt: "2026-09-02T12:00:00.000Z",
            summary: "Repair the incident contact path and repeat the exercise.",
            evidence: [],
          },
        ]
      : [],
    outcome: {
      status: outcome,
      decidedAt: "2026-08-31T13:15:00.000Z",
      decidedBy: "accountable-owner",
      reason: failed ? "The contact-path objective failed." : "Every required objective passed.",
    },
  };
}

describe("incident exercise record validation", () => {
  it("keeps the committed example valid, failed, and ineligible", () => {
    const example = JSON.parse(
      readFileSync(
        new URL("../../docs/engineering/incident-exercise-record.example.json", import.meta.url),
        "utf8",
      ),
    );

    const report = validateIncidentExerciseRecord(example, { now });
    assert.equal(report.outcome, "failed");
    assert.equal(report.readinessEligible, false);
  });

  it("accepts a current passing exercise as readiness-eligible", () => {
    const report = validateIncidentExerciseRecord(createRecord(), { now });

    assert.equal(report.outcome, "passed");
    assert.equal(report.readinessEligible, true);
    assert.equal(report.durationMinutes, 60);
    assert.equal(report.expiresAt, "2026-11-29T13:00:00.000Z");
  });

  it("accepts a failed exercise while keeping it ineligible", () => {
    const report = validateIncidentExerciseRecord(createRecord({ outcome: "failed" }), { now });

    assert.equal(report.outcome, "failed");
    assert.equal(report.readinessEligible, false);
    assert.equal(report.failedObjectives, 1);
    assert.equal(report.openCorrectiveActions, 1);
  });

  it("keeps a structurally valid but expired exercise ineligible", () => {
    const report = validateIncidentExerciseRecord(createRecord(), {
      now: Date.parse("2026-11-29T13:00:00.000Z"),
    });

    assert.equal(report.outcome, "passed");
    assert.equal(report.readinessEligible, false);
  });

  it("accepts direct Node and pnpm-forwarded record paths", () => {
    assert.equal(parseIncidentExerciseRecordPath(["record.json"]), "record.json");
    assert.equal(parseIncidentExerciseRecordPath(["--", "record.json"]), "record.json");
    assert.throws(() => parseIncidentExerciseRecordPath([]), /Usage/);
    assert.throws(() => parseIncidentExerciseRecordPath(["one.json", "two.json"]), /Usage/);
  });

  it("requires every role and objective exactly once", () => {
    const missingRole = createRecord();
    missingRole.participants.pop();
    assert.throws(
      () => validateIncidentExerciseRecord(missingRole, { now }),
      /Missing participant roles/,
    );

    const duplicateObjective = createRecord();
    duplicateObjective.objectives[1].id = duplicateObjective.objectives[0].id;
    assert.throws(
      () => validateIncidentExerciseRecord(duplicateObjective, { now }),
      /Duplicate exercise objective/,
    );
  });

  it("requires an ordered and complete response timeline", () => {
    const missing = createRecord();
    missing.timeline.pop();
    assert.throws(
      () => validateIncidentExerciseRecord(missing, { now }),
      /Missing timeline events/,
    );

    const unordered = createRecord();
    [unordered.timeline[1], unordered.timeline[2]] = [unordered.timeline[2], unordered.timeline[1]];
    assert.throws(() => validateIncidentExerciseRecord(unordered, { now }), /ordered by timestamp/);

    const missingRecoveryEvidence = createRecord();
    missingRecoveryEvidence.timeline[4].evidence = [];
    assert.throws(
      () => validateIncidentExerciseRecord(missingRecoveryEvidence, { now }),
      /must contain evidence/,
    );
  });

  it("rejects a false passing outcome", () => {
    const failedContact = createRecord();
    failedContact.contactPath = {
      ...failedContact.contactPath,
      tested: false,
      result: "not-tested",
    };
    assert.throws(
      () => validateIncidentExerciseRecord(failedContact, { now }),
      /passed outcome requires/,
    );

    const openHigh = createRecord();
    openHigh.correctiveActions.push({
      id: "IRX-1",
      severity: "high",
      status: "open",
      owner: "solo-operator",
      dueAt: "2026-09-02T12:00:00.000Z",
      summary: "Resolve a blocking response gap.",
      evidence: [],
    });
    assert.throws(
      () => validateIncidentExerciseRecord(openHigh, { now }),
      /passed outcome requires/,
    );

    const placeholderRunbook = createRecord();
    placeholderRunbook.runbook.revision = "0".repeat(40);
    assert.throws(
      () => validateIncidentExerciseRecord(placeholderRunbook, { now }),
      /placeholder runbook revision/,
    );
  });

  it("requires closed action evidence and valid timing", () => {
    const closedWithoutEvidence = createRecord();
    closedWithoutEvidence.correctiveActions.push({
      id: "IRX-1",
      severity: "low",
      status: "closed",
      owner: "solo-operator",
      dueAt: "2026-09-02T12:00:00.000Z",
      summary: "Improve a runbook phrase.",
      evidence: [],
    });
    assert.throws(
      () => validateIncidentExerciseRecord(closedWithoutEvidence, { now }),
      /must contain evidence/,
    );

    const tooShort = createRecord();
    tooShort.timing.endedAt = "2026-08-31T12:14:59.000Z";
    assert.throws(
      () => validateIncidentExerciseRecord(tooShort, { now }),
      /between 15 minutes and 8 hours/,
    );

    const future = createRecord();
    future.timing.endedAt = "2026-08-31T16:00:00.000Z";
    future.outcome.decidedAt = "2026-08-31T16:15:00.000Z";
    assert.throws(() => validateIncidentExerciseRecord(future, { now }), /cannot be in the future/);

    const staleDueDate = createRecord({ outcome: "failed" });
    staleDueDate.correctiveActions[0].dueAt = "2026-08-31T13:00:00.000Z";
    assert.throws(
      () => validateIncidentExerciseRecord(staleDueDate, { now }),
      /must follow exercise completion/,
    );
  });

  it("rejects unknown fields and likely secret material", () => {
    const unknownField = createRecord();
    unknownField.rawTranscript = "unexpected";
    assert.throws(
      () => validateIncidentExerciseRecord(unknownField, { now }),
      /must contain exactly/,
    );

    const secret = createRecord();
    secret.timeline[0].summary = "Authorization: Bearer super-sensitive-value";
    assert.throws(() => validateIncidentExerciseRecord(secret, { now }), /secret material/);
  });

  it("requires the canonical versioned runbook and staging boundary", () => {
    const mutableRunbook = createRecord();
    mutableRunbook.runbook.revision = "main";
    assert.throws(
      () => validateIncidentExerciseRecord(mutableRunbook, { now }),
      /full lowercase Git commit/,
    );

    const production = createRecord();
    production.environment = "production";
    assert.throws(() => validateIncidentExerciseRecord(production, { now }), /must be staging/);
  });
});
