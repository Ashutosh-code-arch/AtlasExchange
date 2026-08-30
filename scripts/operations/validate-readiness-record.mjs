import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

export const readinessControls = Object.freeze([
  Object.freeze({ id: "runtime-database-selection", maximumAgeDays: 90 }),
  Object.freeze({ id: "ingress-tls-dns", maximumAgeDays: 30 }),
  Object.freeze({ id: "secrets-rotation", maximumAgeDays: 90 }),
  Object.freeze({ id: "monitoring-alert-delivery", maximumAgeDays: 30 }),
  Object.freeze({ id: "database-capacity", maximumAgeDays: 30 }),
  Object.freeze({ id: "provider-pitr-drill", maximumAgeDays: 90 }),
  Object.freeze({ id: "logical-restore-drill", maximumAgeDays: 31 }),
  Object.freeze({ id: "candidate-vulnerability-scan", maximumAgeDays: 7 }),
  Object.freeze({ id: "release-provenance", maximumAgeDays: 7 }),
  Object.freeze({ id: "rollback-plan", maximumAgeDays: 7 }),
  Object.freeze({ id: "synthetic-smoke-tests", maximumAgeDays: 1 }),
  Object.freeze({ id: "incident-response-exercise", maximumAgeDays: 90 }),
  Object.freeze({ id: "product-scope-approval", maximumAgeDays: 30 }),
]);

const readinessControlById = new Map(readinessControls.map((control) => [control.id, control]));
const controlStatuses = new Set(["passed", "blocked", "not-evaluated"]);

function assertObject(value, field) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function assertString(value, field) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function parseTimestamp(value, field) {
  const timestampValue = assertString(value, field);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}))?Z$/.exec(timestampValue);
  if (match === null) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp`);
  }
  const timestamp = Date.parse(timestampValue);
  const canonicalTimestamp = `${match[1]}.${match[2] ?? "000"}Z`;
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString() !== canonicalTimestamp) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp`);
  }
  return timestamp;
}

function validateRelease(value) {
  const release = assertObject(value, "release");
  const version = assertString(release.version, "release.version");
  const revision = assertString(release.revision, "release.revision");
  const apiImageDigest = assertString(release.apiImageDigest, "release.apiImageDigest");
  const webImageDigest = assertString(release.webImageDigest, "release.webImageDigest");

  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("release.version must use stable MAJOR.MINOR.PATCH syntax");
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("release.revision must be a full lowercase Git commit");
  }
  for (const [field, digest] of [
    ["release.apiImageDigest", apiImageDigest],
    ["release.webImageDigest", webImageDigest],
  ]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`${field} must be an immutable SHA-256 image digest`);
    }
  }

  return { apiImageDigest, revision, version, webImageDigest };
}

function validateDecision(value) {
  const decision = assertObject(value, "decision");
  if (decision.outcome !== "go" && decision.outcome !== "no-go") {
    throw new Error('decision.outcome must be either "go" or "no-go"');
  }
  const decidedAt = parseTimestamp(decision.decidedAt, "decision.decidedAt");
  assertString(decision.decidedBy, "decision.decidedBy");
  assertString(decision.reason, "decision.reason");
  return { decidedAt, outcome: decision.outcome };
}

function validateEvidence(control, decidedAt) {
  if (!Array.isArray(control.evidence) || control.evidence.length === 0) {
    throw new Error(`${control.id} passed evidence must contain at least one reference`);
  }
  for (const [index, reference] of control.evidence.entries()) {
    assertString(reference, `${control.id}.evidence[${String(index)}]`);
  }

  const observedAt = parseTimestamp(control.observedAt, `${control.id}.observedAt`);
  const expiresAt = parseTimestamp(control.expiresAt, `${control.id}.expiresAt`);
  if (observedAt > decidedAt) {
    throw new Error(`${control.id} evidence cannot be observed after the decision`);
  }
  if (expiresAt <= decidedAt) {
    throw new Error(`${control.id} evidence is expired at the decision time`);
  }
  if (expiresAt <= observedAt) {
    throw new Error(`${control.id} evidence must expire after it was observed`);
  }

  const policy = readinessControlById.get(control.id);
  if (expiresAt - observedAt > policy.maximumAgeDays * millisecondsPerDay) {
    throw new Error(
      `${control.id} evidence exceeds its ${String(policy.maximumAgeDays)}-day freshness policy`,
    );
  }
}

function validateControls(value, decision) {
  if (!Array.isArray(value)) throw new Error("controls must be an array");
  const seen = new Set();
  const blockingControls = [];
  let passedControls = 0;

  for (const [index, item] of value.entries()) {
    const control = assertObject(item, `controls[${String(index)}]`);
    const id = assertString(control.id, `controls[${String(index)}].id`);
    if (!readinessControlById.has(id)) throw new Error(`Unknown readiness control: ${id}`);
    if (seen.has(id)) throw new Error(`Duplicate readiness control: ${id}`);
    seen.add(id);

    if (!controlStatuses.has(control.status)) {
      throw new Error(`${id}.status must be passed, blocked, or not-evaluated`);
    }
    if (control.status === "passed") {
      validateEvidence(control, decision.decidedAt);
      passedControls += 1;
    } else {
      assertString(control.notes, `${id}.notes`);
      blockingControls.push(id);
    }
  }

  const missing = readinessControls
    .map((control) => control.id)
    .filter((controlId) => !seen.has(controlId));
  if (missing.length > 0) {
    throw new Error(`Missing readiness controls: ${missing.join(", ")}`);
  }
  if (seen.size !== readinessControls.length) {
    throw new Error("Readiness record must contain exactly the required controls");
  }
  if (decision.outcome === "go" && blockingControls.length > 0) {
    throw new Error(
      `A go decision cannot contain blocking controls: ${blockingControls.join(", ")}`,
    );
  }

  return { blockingControls, passedControls };
}

export function validateReadinessRecord(value) {
  const record = assertObject(value, "readiness record");
  if (record.schemaVersion !== 1) throw new Error("schemaVersion must equal 1");
  const environment = assertString(record.environment, "environment");
  if (environment !== "staging" && environment !== "production") {
    throw new Error("environment must be staging or production");
  }

  const release = validateRelease(record.release);
  const decision = validateDecision(record.decision);
  const controls = validateControls(record.controls, decision);

  return Object.freeze({
    blockingControls: Object.freeze(controls.blockingControls),
    environment,
    outcome: decision.outcome,
    passedControls: controls.passedControls,
    releaseRevision: release.revision,
    releaseVersion: release.version,
    totalControls: readinessControls.length,
  });
}

export async function validateReadinessRecordFile(path) {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  return validateReadinessRecord(parsed);
}

export function parseReadinessRecordPath(arguments_) {
  const normalizedArguments = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (normalizedArguments.length !== 1) {
    throw new Error("Usage: pnpm readiness:validate -- <readiness-record.json>");
  }
  return normalizedArguments[0];
}

async function main(arguments_) {
  const report = await validateReadinessRecordFile(parseReadinessRecordPath(arguments_));
  process.stdout.write(
    `${JSON.stringify({ event: "operations.readiness_record.validated", report })}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `Atlas readiness validation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
