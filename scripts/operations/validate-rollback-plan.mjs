import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;
const maximumEvidenceAgeDays = 7;

export const contractChecks = Object.freeze([
  "previous-web-to-candidate-api",
  "candidate-web-to-previous-api",
  "market-data-websocket",
]);

export const rollbackSteps = Object.freeze([
  "stop-rollout",
  "determine-migration-state",
  "freeze-unsafe-mutations",
  "change-traffic",
  "verify-release-identity",
  "validate-health-and-session",
  "validate-financial-and-trading",
  "validate-observability",
  "communicate-and-monitor",
]);

const contractCheckIds = new Set(contractChecks);
const rollbackStepIds = new Set(rollbackSteps);
const contractStatuses = new Set(["compatible", "incompatible", "not-applicable", "not-evaluated"]);
const migrationCompatibilities = new Set([
  "backward-compatible",
  "breaking",
  "not-applicable",
  "not-evaluated",
]);
const databaseCompatibilityDecisions = new Set([
  "previous-api-compatible",
  "incompatible",
  "not-applicable",
  "not-evaluated",
]);
const rollbackActions = new Set([
  "retain-forward-schema",
  "forward-fix-or-recover",
  "not-evaluated",
]);
const baselineStatuses = new Set(["verified", "blocked"]);
const strategies = new Set(["previous-release-set", "remove-traffic", "blocked"]);
const placeholderPattern =
  /(?:example-only|not-(?:configured|selected|tested)|replace-with|tbd|todo)/i;
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

function assertSafeString(value, field, { allowPlaceholder = true } = {}) {
  const string = assertString(value, field);
  if (string.length > 500) throw new Error(`${field} must contain at most 500 characters`);
  if (secretPatterns.some((pattern) => pattern.test(string))) {
    throw new Error(`${field} appears to contain secret material`);
  }
  if (!allowPlaceholder && placeholderPattern.test(string)) {
    throw new Error(`${field} must not contain a placeholder in a ready plan`);
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

function validateEvidence(value, field, { required, allowPlaceholder }) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (required && value.length === 0) throw new Error(`${field} must contain evidence`);
  if (value.length > 10) throw new Error(`${field} must contain at most 10 references`);
  const seen = new Set();
  for (const [index, referenceValue] of value.entries()) {
    const reference = assertSafeString(referenceValue, `${field}[${String(index)}]`, {
      allowPlaceholder,
    });
    if (reference.length > 240) throw new Error(`${field}[${String(index)}] is too long`);
    if (seen.has(reference)) throw new Error(`${field} must not contain duplicate references`);
    seen.add(reference);
  }
}

function validateRelease(value, field) {
  const release = assertExactKeys(
    value,
    ["apiImageDigest", "metricsCollectorImageDigest", "revision", "version", "webImageDigest"],
    field,
  );
  const version = assertString(release.version, `${field}.version`);
  const revision = assertString(release.revision, `${field}.revision`);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`${field}.version must use stable MAJOR.MINOR.PATCH syntax`);
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(`${field}.revision must be a full lowercase Git commit`);
  }
  const digests = {};
  for (const digestField of ["apiImageDigest", "webImageDigest", "metricsCollectorImageDigest"]) {
    const digest = assertString(release[digestField], `${field}.${digestField}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`${field}.${digestField} must be an immutable SHA-256 image digest`);
    }
    digests[digestField] = digest;
  }
  return { ...digests, revision, version };
}

function releaseIsPlaceholder(release) {
  return (
    /^0+$/.test(release.revision) ||
    [release.apiImageDigest, release.webImageDigest, release.metricsCollectorImageDigest].some(
      (digest) => /^sha256:0+$/.test(digest),
    )
  );
}

function releasesMatch(left, right) {
  return (
    left.version === right.version &&
    left.revision === right.revision &&
    left.apiImageDigest === right.apiImageDigest &&
    left.webImageDigest === right.webImageDigest &&
    left.metricsCollectorImageDigest === right.metricsCollectorImageDigest
  );
}

function validateDecision(value, now) {
  const decision = assertExactKeys(
    value,
    ["decidedAt", "decidedBy", "outcome", "reason"],
    "decision",
  );
  if (decision.outcome !== "ready" && decision.outcome !== "blocked") {
    throw new Error("decision.outcome must be ready or blocked");
  }
  const decidedAt = parseTimestamp(decision.decidedAt, "decision.decidedAt");
  if (decidedAt > now) throw new Error("decision.decidedAt cannot be in the future");
  const ready = decision.outcome === "ready";
  assertSafeString(decision.decidedBy, "decision.decidedBy", { allowPlaceholder: !ready });
  assertSafeString(decision.reason, "decision.reason", { allowPlaceholder: !ready });
  return { decidedAt, outcome: decision.outcome, ready };
}

function validateBaseline(value, ready) {
  const baseline = assertExactKeys(value, ["evidence", "kind", "release", "status"], "baseline");
  if (baseline.kind !== "previous-release" && baseline.kind !== "first-release") {
    throw new Error("baseline.kind must be previous-release or first-release");
  }
  if (!baselineStatuses.has(baseline.status)) {
    throw new Error("baseline.status must be verified or blocked");
  }
  const verified = baseline.status === "verified";
  let release;
  if (baseline.kind === "previous-release") {
    release = validateRelease(baseline.release, "baseline.release");
    if (verified && releaseIsPlaceholder(release)) {
      throw new Error("A verified baseline cannot use placeholder release identity");
    }
  } else if (baseline.release !== null) {
    throw new Error("A first-release baseline must have a null release");
  }
  validateEvidence(baseline.evidence, "baseline.evidence", {
    allowPlaceholder: !verified,
    required: verified,
  });
  if (ready && !verified) throw new Error("A ready plan requires a verified baseline");
  return { blockingItems: verified ? 0 : 1, kind: baseline.kind, release };
}

function validateMigration(value, index) {
  const migration = assertExactKeys(
    value,
    ["checksum", "compatibility", "evidence", "name"],
    `database.newMigrations[${String(index)}]`,
  );
  const name = assertString(migration.name, `database.newMigrations[${String(index)}].name`);
  if (!/^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/.test(name)) {
    throw new Error(`${name} must be a canonical migration filename`);
  }
  if (!/^[0-9a-f]{64}$/.test(assertString(migration.checksum, `${name}.checksum`))) {
    throw new Error(`${name}.checksum must be a lowercase SHA-256 value`);
  }
  if (!migrationCompatibilities.has(migration.compatibility)) {
    throw new Error(`${name}.compatibility is not supported`);
  }
  validateEvidence(migration.evidence, `${name}.evidence`, {
    allowPlaceholder:
      migration.compatibility !== "backward-compatible" &&
      migration.compatibility !== "not-applicable",
    required:
      migration.compatibility === "backward-compatible" ||
      migration.compatibility === "not-applicable",
  });
  return { compatibility: migration.compatibility, name };
}

function validateDatabase(value, baselineKind) {
  const database = assertExactKeys(
    value,
    [
      "candidateSchemaVersion",
      "compatibilityDecision",
      "currentSchemaVersion",
      "newMigrations",
      "recoveryPointEvidence",
      "reviewedBy",
      "rollbackAction",
    ],
    "database",
  );
  const schemaPattern = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
  const currentSchemaVersion = assertString(
    database.currentSchemaVersion,
    "database.currentSchemaVersion",
  );
  const candidateSchemaVersion = assertString(
    database.candidateSchemaVersion,
    "database.candidateSchemaVersion",
  );
  if (currentSchemaVersion !== "none" && !schemaPattern.test(currentSchemaVersion)) {
    throw new Error("database.currentSchemaVersion must be none or a canonical migration filename");
  }
  if (!schemaPattern.test(candidateSchemaVersion)) {
    throw new Error("database.candidateSchemaVersion must be a canonical migration filename");
  }
  if (baselineKind === "previous-release" && currentSchemaVersion === "none") {
    throw new Error("A previous-release baseline must have a current schema version");
  }
  if (!databaseCompatibilityDecisions.has(database.compatibilityDecision)) {
    throw new Error("database.compatibilityDecision is not supported");
  }
  if (!rollbackActions.has(database.rollbackAction)) {
    throw new Error("database.rollbackAction is not supported");
  }
  const reviewComplete =
    database.compatibilityDecision !== "not-evaluated" &&
    database.rollbackAction !== "not-evaluated";
  assertSafeString(database.reviewedBy, "database.reviewedBy", {
    allowPlaceholder: !reviewComplete,
  });
  if (!Array.isArray(database.newMigrations))
    throw new Error("database.newMigrations must be an array");
  if (database.newMigrations.length > 100) {
    throw new Error("database.newMigrations must contain at most 100 migrations");
  }
  const migrations = database.newMigrations.map((migration, index) =>
    validateMigration(migration, index),
  );
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1].name >= migrations[index].name) {
      throw new Error("database.newMigrations must be strictly ordered by name");
    }
  }
  if (migrations.length > 0 && migrations.at(-1).name !== candidateSchemaVersion) {
    throw new Error("The final new migration must equal database.candidateSchemaVersion");
  }
  if (
    reviewComplete &&
    currentSchemaVersion !== candidateSchemaVersion &&
    migrations.length === 0
  ) {
    throw new Error("A completed schema change review must list its new migrations");
  }
  if (reviewComplete && currentSchemaVersion === candidateSchemaVersion && migrations.length > 0) {
    throw new Error("A completed review cannot list migrations when schema versions are unchanged");
  }
  validateEvidence(database.recoveryPointEvidence, "database.recoveryPointEvidence", {
    allowPlaceholder: !reviewComplete,
    required: reviewComplete,
  });

  const expectedMigrationCompatibility =
    baselineKind === "previous-release" ? "backward-compatible" : "not-applicable";
  const incompatibleMigrations = migrations.filter(
    (migration) => migration.compatibility !== expectedMigrationCompatibility,
  ).length;
  return {
    incompatibleMigrations,
    compatibilityDecision: database.compatibilityDecision,
    rollbackAction: database.rollbackAction,
  };
}

function validateContracts(value, baselineKind, ready) {
  if (!Array.isArray(value)) throw new Error("contracts must be an array");
  const seen = new Set();
  let incompatible = 0;
  for (const [index, item] of value.entries()) {
    const check = assertExactKeys(
      item,
      ["evidence", "id", "notes", "status"],
      `contracts[${String(index)}]`,
    );
    const id = assertString(check.id, `contracts[${String(index)}].id`);
    if (!contractCheckIds.has(id)) throw new Error(`Unknown contract check: ${id}`);
    if (seen.has(id)) throw new Error(`Duplicate contract check: ${id}`);
    seen.add(id);
    if (!contractStatuses.has(check.status)) throw new Error(`${id}.status is not supported`);
    const expected = baselineKind === "previous-release" ? "compatible" : "not-applicable";
    if (check.status !== expected) incompatible += 1;
    assertSafeString(check.notes, `${id}.notes`, { allowPlaceholder: !ready });
    validateEvidence(check.evidence, `${id}.evidence`, {
      allowPlaceholder: check.status !== "compatible",
      required: check.status === "compatible",
    });
  }
  const missing = contractChecks.filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`Missing contract checks: ${missing.join(", ")}`);
  if (seen.size !== contractChecks.length) {
    throw new Error("contracts must contain exactly the required checks");
  }
  return incompatible;
}

function validateProcedure(value, ready) {
  const procedure = assertExactKeys(
    value,
    ["rehearsalEvidence", "rehearsed", "steps", "strategy"],
    "procedure",
  );
  if (!strategies.has(procedure.strategy)) throw new Error("procedure.strategy is not supported");
  if (typeof procedure.rehearsed !== "boolean")
    throw new Error("procedure.rehearsed must be a boolean");
  validateEvidence(procedure.rehearsalEvidence, "procedure.rehearsalEvidence", {
    allowPlaceholder: !procedure.rehearsed,
    required: procedure.rehearsed,
  });
  if (ready && !procedure.rehearsed)
    throw new Error("A ready rollback procedure must be rehearsed");
  if (!Array.isArray(procedure.steps)) throw new Error("procedure.steps must be an array");
  const seen = new Set();
  for (const [index, item] of procedure.steps.entries()) {
    const step = assertExactKeys(
      item,
      ["id", "instruction", "owner"],
      `procedure.steps[${String(index)}]`,
    );
    const id = assertString(step.id, `procedure.steps[${String(index)}].id`);
    if (!rollbackStepIds.has(id)) throw new Error(`Unknown rollback step: ${id}`);
    if (seen.has(id)) throw new Error(`Duplicate rollback step: ${id}`);
    seen.add(id);
    if (id !== rollbackSteps[index]) throw new Error("procedure.steps must use the required order");
    assertSafeString(step.owner, `${id}.owner`, { allowPlaceholder: !ready });
    assertSafeString(step.instruction, `${id}.instruction`, { allowPlaceholder: !ready });
  }
  const missing = rollbackSteps.filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`Missing rollback steps: ${missing.join(", ")}`);
  if (seen.size !== rollbackSteps.length) {
    throw new Error("procedure.steps must contain exactly the required steps");
  }
  return { rehearsed: procedure.rehearsed, strategy: procedure.strategy };
}

export function validateRollbackPlan(value, { now = Date.now() } = {}) {
  const record = assertExactKeys(
    value,
    [
      "baseline",
      "candidate",
      "contracts",
      "database",
      "decision",
      "environment",
      "planId",
      "procedure",
      "schemaVersion",
    ],
    "rollback plan",
  );
  if (record.schemaVersion !== 1) throw new Error("schemaVersion must equal 1");
  const planId = assertString(record.planId, "planId");
  if (!/^rollback-\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(planId)) {
    throw new Error("planId must use rollback-YYYY-MM-DD-slug syntax");
  }
  if (record.environment !== "staging" && record.environment !== "production") {
    throw new Error("environment must be staging or production");
  }
  const decision = validateDecision(record.decision, now);
  const candidate = validateRelease(record.candidate, "candidate");
  if (decision.ready && releaseIsPlaceholder(candidate)) {
    throw new Error("A ready plan cannot use placeholder candidate release identity");
  }
  const baseline = validateBaseline(record.baseline, decision.ready);
  if (baseline.release !== undefined && releasesMatch(candidate, baseline.release)) {
    throw new Error("Candidate and baseline release identities must differ");
  }
  const database = validateDatabase(record.database, baseline.kind);
  const incompatibleContracts = validateContracts(record.contracts, baseline.kind, decision.ready);
  const procedure = validateProcedure(record.procedure, decision.ready);

  let blockingItems =
    baseline.blockingItems + database.incompatibleMigrations + incompatibleContracts;
  if (releaseIsPlaceholder(candidate)) blockingItems += 1;
  if (baseline.kind === "previous-release") {
    if (database.compatibilityDecision !== "previous-api-compatible") blockingItems += 1;
    if (database.rollbackAction !== "retain-forward-schema") blockingItems += 1;
    if (procedure.strategy !== "previous-release-set") blockingItems += 1;
  } else {
    if (database.compatibilityDecision !== "not-applicable") blockingItems += 1;
    if (database.rollbackAction !== "forward-fix-or-recover") blockingItems += 1;
    if (procedure.strategy !== "remove-traffic") blockingItems += 1;
  }
  if (!procedure.rehearsed) blockingItems += 1;

  if (decision.outcome === "ready" && blockingItems > 0) {
    throw new Error("A ready decision cannot contain blocking rollback conditions");
  }
  if (decision.outcome === "blocked" && blockingItems === 0) {
    throw new Error("A blocked decision must identify at least one blocking rollback condition");
  }

  const expiresAt = decision.decidedAt + maximumEvidenceAgeDays * millisecondsPerDay;
  const readinessEligible = decision.outcome === "ready" && now < expiresAt;
  return Object.freeze({
    baselineKind: baseline.kind,
    blockingItems,
    candidateRevision: candidate.revision,
    candidateVersion: candidate.version,
    environment: record.environment,
    expiresAt: new Date(expiresAt).toISOString(),
    observedAt: new Date(decision.decidedAt).toISOString(),
    outcome: decision.outcome,
    planId,
    readinessEligible,
    strategy: procedure.strategy,
  });
}

export async function validateRollbackPlanFile(path, options) {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  return validateRollbackPlan(parsed, options);
}

export function parseRollbackPlanPath(arguments_) {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (normalized.length !== 1) {
    throw new Error("Usage: pnpm rollback:validate -- <rollback-plan.json>");
  }
  return normalized[0];
}

async function main(arguments_) {
  const report = await validateRollbackPlanFile(parseRollbackPlanPath(arguments_));
  process.stdout.write(
    `${JSON.stringify({ event: "operations.rollback_plan.validated", report })}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `Atlas rollback-plan validation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
