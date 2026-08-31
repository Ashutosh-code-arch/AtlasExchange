import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const millisecondsPerMinute = 60 * 1_000;
const millisecondsPerDay = 24 * 60 * 60 * 1_000;
const maximumEvidenceAgeDays = 90;

export const exerciseModes = Object.freeze(["tabletop", "simulation"]);
export const exerciseScenarios = Object.freeze([
  "credential-compromise",
  "database-recovery",
  "financial-integrity",
  "release-rollback",
  "service-outage",
  "vulnerability-response",
]);
export const participantRoles = Object.freeze([
  "incident-commander",
  "operations-lead",
  "communications-lead",
  "scribe",
]);
export const exerciseObjectives = Object.freeze([
  "declare-and-scope",
  "contain-safely",
  "preserve-evidence",
  "validate-recovery",
  "communicate-status",
  "close-and-own-followups",
]);
export const timelineEvents = Object.freeze([
  "inject",
  "incident-declared",
  "containment-decision",
  "status-communication",
  "recovery-validation",
  "closure-decision",
]);

const modes = new Set(exerciseModes);
const scenarios = new Set(exerciseScenarios);
const roles = new Set(participantRoles);
const objectives = new Set(exerciseObjectives);
const events = new Set(timelineEvents);
const severities = new Set(["critical", "high", "medium", "low"]);
const actionStatuses = new Set(["open", "closed"]);
const resultStatuses = new Set(["passed", "failed"]);
const contactResults = new Set(["passed", "failed", "not-tested"]);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/i,
  /\b(?:authorization|cookie|password|secret|token)\s*[:=]\s*\S+/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

function assertObject(value, field) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, field) {
  const object = assertObject(value, field);
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} must contain exactly: ${expected.join(", ")}`);
  }
  return object;
}

function assertString(value, field) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  if (
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw new Error(`${field} must not contain control characters`);
  }
  return value;
}

function assertSafeString(value, field) {
  const string = assertString(value, field);
  if (string.length > 500) throw new Error(`${field} must contain at most 500 characters`);
  if (secretPatterns.some((pattern) => pattern.test(string))) {
    throw new Error(`${field} appears to contain secret material`);
  }
  return string;
}

function parseTimestamp(value, field) {
  const timestampValue = assertString(value, field);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}))?Z$/.exec(timestampValue);
  if (match === null) throw new Error(`${field} must be an ISO-8601 UTC timestamp`);
  const timestamp = Date.parse(timestampValue);
  const canonical = `${match[1]}.${match[2] ?? "000"}Z`;
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString() !== canonical) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp`);
  }
  return timestamp;
}

function validateEvidence(value, field, { required }) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (required && value.length === 0) throw new Error(`${field} must contain evidence`);
  if (value.length > 10) throw new Error(`${field} must contain at most 10 references`);
  const seen = new Set();
  for (const [index, referenceValue] of value.entries()) {
    const reference = assertSafeString(referenceValue, `${field}[${String(index)}]`);
    if (reference.length > 240) throw new Error(`${field}[${String(index)}] is too long`);
    if (seen.has(reference)) throw new Error(`${field} must not contain duplicate references`);
    seen.add(reference);
  }
}

function validateScenario(value) {
  const scenario = assertExactKeys(value, ["expectedSeverity", "title", "type"], "scenario");
  if (!scenarios.has(scenario.type)) throw new Error("scenario.type is not supported");
  if (!["SEV-1", "SEV-2", "SEV-3", "SEV-4"].includes(scenario.expectedSeverity)) {
    throw new Error("scenario.expectedSeverity must be SEV-1, SEV-2, SEV-3, or SEV-4");
  }
  assertSafeString(scenario.title, "scenario.title");
  return scenario.type;
}

function validateRunbook(value) {
  const runbook = assertExactKeys(value, ["reference", "revision"], "runbook");
  const reference = assertSafeString(runbook.reference, "runbook.reference");
  if (reference !== "docs/engineering/operational-readiness.md") {
    throw new Error("runbook.reference must identify the canonical operational-readiness runbook");
  }
  const revision = assertString(runbook.revision, "runbook.revision");
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("runbook.revision must be a full lowercase Git commit");
  }
  return revision;
}

function validateContactPath(value) {
  const contactPath = assertExactKeys(value, ["reference", "result", "tested"], "contactPath");
  assertSafeString(contactPath.reference, "contactPath.reference");
  if (typeof contactPath.tested !== "boolean") {
    throw new Error("contactPath.tested must be a boolean");
  }
  if (!contactResults.has(contactPath.result)) {
    throw new Error("contactPath.result must be passed, failed, or not-tested");
  }
  if (contactPath.tested === (contactPath.result === "not-tested")) {
    throw new Error("contactPath.tested and contactPath.result must agree");
  }
  return contactPath.result;
}

function validateParticipants(value) {
  if (!Array.isArray(value)) throw new Error("participants must be an array");
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    const participant = assertExactKeys(
      item,
      ["operator", "role"],
      `participants[${String(index)}]`,
    );
    if (!roles.has(participant.role))
      throw new Error(`Unknown participant role: ${String(participant.role)}`);
    if (seen.has(participant.role))
      throw new Error(`Duplicate participant role: ${participant.role}`);
    seen.add(participant.role);
    assertSafeString(participant.operator, `participants[${String(index)}].operator`);
  }
  const missing = participantRoles.filter((role) => !seen.has(role));
  if (missing.length > 0) throw new Error(`Missing participant roles: ${missing.join(", ")}`);
  if (seen.size !== participantRoles.length) {
    throw new Error("participants must contain exactly the required roles");
  }
}

function validateObjectives(value) {
  if (!Array.isArray(value)) throw new Error("objectives must be an array");
  const seen = new Set();
  let failed = 0;
  for (const [index, item] of value.entries()) {
    const objective = assertExactKeys(
      item,
      ["evidence", "id", "notes", "status"],
      `objectives[${String(index)}]`,
    );
    if (!objectives.has(objective.id))
      throw new Error(`Unknown exercise objective: ${String(objective.id)}`);
    if (seen.has(objective.id)) throw new Error(`Duplicate exercise objective: ${objective.id}`);
    seen.add(objective.id);
    if (!resultStatuses.has(objective.status)) {
      throw new Error(`${objective.id}.status must be passed or failed`);
    }
    assertSafeString(objective.notes, `${objective.id}.notes`);
    validateEvidence(objective.evidence, `${objective.id}.evidence`, {
      required: objective.status === "passed",
    });
    if (objective.status === "failed") failed += 1;
  }
  const missing = exerciseObjectives.filter((objective) => !seen.has(objective));
  if (missing.length > 0) throw new Error(`Missing exercise objectives: ${missing.join(", ")}`);
  if (seen.size !== exerciseObjectives.length) {
    throw new Error("objectives must contain exactly the required objectives");
  }
  return failed;
}

function validateTimeline(value, startedAt, endedAt) {
  if (!Array.isArray(value)) throw new Error("timeline must be an array");
  if (value.length > 100) throw new Error("timeline must contain at most 100 events");
  const firstOccurrence = new Map();
  let previousAt = -Infinity;
  for (const [index, item] of value.entries()) {
    const entry = assertExactKeys(
      item,
      ["actor", "at", "event", "evidence", "summary"],
      `timeline[${String(index)}]`,
    );
    if (!events.has(entry.event)) throw new Error(`Unknown timeline event: ${String(entry.event)}`);
    const at = parseTimestamp(entry.at, `timeline[${String(index)}].at`);
    if (at < startedAt || at > endedAt) {
      throw new Error(`timeline[${String(index)}].at must fall within exercise timing`);
    }
    if (at < previousAt) throw new Error("timeline must be ordered by timestamp");
    previousAt = at;
    if (!firstOccurrence.has(entry.event)) firstOccurrence.set(entry.event, index);
    assertSafeString(entry.actor, `timeline[${String(index)}].actor`);
    assertSafeString(entry.summary, `timeline[${String(index)}].summary`);
    validateEvidence(entry.evidence, `timeline[${String(index)}].evidence`, {
      required: entry.event === "recovery-validation",
    });
  }
  const missing = timelineEvents.filter((event) => !firstOccurrence.has(event));
  if (missing.length > 0) throw new Error(`Missing timeline events: ${missing.join(", ")}`);
  let previousIndex = -1;
  for (const event of timelineEvents) {
    const index = firstOccurrence.get(event);
    if (index < previousIndex)
      throw new Error("Required timeline events must occur in response order");
    previousIndex = index;
  }
}

function validateCorrectiveActions(value, endedAt) {
  if (!Array.isArray(value)) throw new Error("correctiveActions must be an array");
  if (value.length > 50) throw new Error("correctiveActions must contain at most 50 actions");
  const seen = new Set();
  let openHighOrCritical = 0;
  let open = 0;
  for (const [index, item] of value.entries()) {
    const action = assertExactKeys(
      item,
      ["dueAt", "evidence", "id", "owner", "severity", "status", "summary"],
      `correctiveActions[${String(index)}]`,
    );
    const id = assertString(action.id, `correctiveActions[${String(index)}].id`);
    if (!/^IRX-[1-9]\d*$/.test(id)) throw new Error(`${id} must use IRX-<positive integer> syntax`);
    if (seen.has(id)) throw new Error(`Duplicate corrective action: ${id}`);
    seen.add(id);
    if (!severities.has(action.severity)) throw new Error(`${id}.severity is not supported`);
    if (!actionStatuses.has(action.status)) throw new Error(`${id}.status must be open or closed`);
    assertSafeString(action.owner, `${id}.owner`);
    assertSafeString(action.summary, `${id}.summary`);
    const dueAt = parseTimestamp(action.dueAt, `${id}.dueAt`);
    if (dueAt <= endedAt) throw new Error(`${id}.dueAt must follow exercise completion`);
    validateEvidence(action.evidence, `${id}.evidence`, { required: action.status === "closed" });
    if (action.status === "open") {
      open += 1;
      if (action.severity === "critical" || action.severity === "high") openHighOrCritical += 1;
    }
  }
  return { open, openHighOrCritical };
}

function validateOutcome(value, endedAt, now) {
  const outcome = assertExactKeys(value, ["decidedAt", "decidedBy", "reason", "status"], "outcome");
  if (!resultStatuses.has(outcome.status))
    throw new Error("outcome.status must be passed or failed");
  const decidedAt = parseTimestamp(outcome.decidedAt, "outcome.decidedAt");
  if (decidedAt < endedAt) throw new Error("outcome.decidedAt cannot precede exercise completion");
  if (decidedAt - endedAt > millisecondsPerDay) {
    throw new Error("outcome.decidedAt must be within 24 hours of exercise completion");
  }
  if (decidedAt > now) throw new Error("outcome.decidedAt cannot be in the future");
  assertSafeString(outcome.decidedBy, "outcome.decidedBy");
  assertSafeString(outcome.reason, "outcome.reason");
  return outcome.status;
}

export function validateIncidentExerciseRecord(value, { now = Date.now() } = {}) {
  const record = assertExactKeys(
    value,
    [
      "contactPath",
      "correctiveActions",
      "environment",
      "exerciseId",
      "mode",
      "objectives",
      "outcome",
      "participants",
      "runbook",
      "scenario",
      "schemaVersion",
      "timeline",
      "timing",
    ],
    "incident exercise record",
  );
  if (record.schemaVersion !== 1) throw new Error("schemaVersion must equal 1");
  const exerciseId = assertString(record.exerciseId, "exerciseId");
  if (!/^irx-\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(exerciseId)) {
    throw new Error("exerciseId must use irx-YYYY-MM-DD-slug syntax");
  }
  if (!modes.has(record.mode)) throw new Error("mode must be tabletop or simulation");
  if (record.environment !== "staging") throw new Error("environment must be staging");
  const scenario = validateScenario(record.scenario);
  const runbookRevision = validateRunbook(record.runbook);
  const contactResult = validateContactPath(record.contactPath);

  const timing = assertExactKeys(record.timing, ["endedAt", "startedAt"], "timing");
  const startedAt = parseTimestamp(timing.startedAt, "timing.startedAt");
  const endedAt = parseTimestamp(timing.endedAt, "timing.endedAt");
  const durationMinutes = (endedAt - startedAt) / millisecondsPerMinute;
  if (durationMinutes < 15 || durationMinutes > 8 * 60) {
    throw new Error("exercise duration must be between 15 minutes and 8 hours");
  }
  if (endedAt > now) throw new Error("timing.endedAt cannot be in the future");

  validateParticipants(record.participants);
  const failedObjectives = validateObjectives(record.objectives);
  validateTimeline(record.timeline, startedAt, endedAt);
  const actions = validateCorrectiveActions(record.correctiveActions, endedAt);
  const outcome = validateOutcome(record.outcome, endedAt, now);

  const hasPassingConditions =
    contactResult === "passed" && failedObjectives === 0 && actions.openHighOrCritical === 0;
  if (outcome === "passed" && !hasPassingConditions) {
    throw new Error(
      "A passed outcome requires a tested contact path, all objectives passed, and no open high/critical actions",
    );
  }
  if (outcome === "passed" && /^0+$/.test(runbookRevision)) {
    throw new Error("A passed outcome cannot use the placeholder runbook revision");
  }
  if (outcome === "failed" && hasPassingConditions) {
    throw new Error(
      "A failed outcome must identify a failed objective, contact path, or open high/critical action",
    );
  }

  const expiresAt = endedAt + maximumEvidenceAgeDays * millisecondsPerDay;
  const readinessEligible = outcome === "passed" && now < expiresAt;
  return Object.freeze({
    durationMinutes,
    environment: record.environment,
    exerciseId,
    expiresAt: new Date(expiresAt).toISOString(),
    failedObjectives,
    mode: record.mode,
    observedAt: new Date(endedAt).toISOString(),
    openCorrectiveActions: actions.open,
    outcome,
    readinessEligible,
    scenario,
  });
}

export async function validateIncidentExerciseRecordFile(path, options) {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  return validateIncidentExerciseRecord(parsed, options);
}

export function parseIncidentExerciseRecordPath(arguments_) {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (normalized.length !== 1) {
    throw new Error("Usage: pnpm incident:exercise:validate -- <incident-exercise-record.json>");
  }
  return normalized[0];
}

async function main(arguments_) {
  const report = await validateIncidentExerciseRecordFile(
    parseIncidentExerciseRecordPath(arguments_),
  );
  process.stdout.write(
    `${JSON.stringify({ event: "operations.incident_exercise.validated", report })}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `Atlas incident exercise validation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
