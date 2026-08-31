import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;
const maximumEvidenceAgeDays = 30;

export const deploymentControlRequirements = Object.freeze([
  Object.freeze({ id: "simulated-funding", requiredSetting: "SIMULATED_FUNDING_ENABLED=false" }),
  Object.freeze({
    id: "simulated-withdrawals",
    requiredSetting: "SIMULATED_WITHDRAWALS_ENABLED=false",
  }),
  Object.freeze({ id: "real-custody", requiredSetting: "capability-absent" }),
  Object.freeze({ id: "external-market-execution", requiredSetting: "capability-absent" }),
  Object.freeze({ id: "fiat-payments", requiredSetting: "capability-absent" }),
  Object.freeze({ id: "transferable-value", requiredSetting: "capability-absent" }),
]);

export const disclosureRequirements = Object.freeze([
  "simulation-prominence",
  "no-real-assets",
  "no-external-execution",
  "no-financial-advice",
  "support-and-privacy-paths",
]);

export const dataCategories = Object.freeze([
  "account-email",
  "credential-and-session-security",
  "operational-security-metadata",
  "simulation-activity",
]);

const deploymentRequirementById = new Map(
  deploymentControlRequirements.map((requirement) => [requirement.id, requirement]),
);
const disclosureIds = new Set(disclosureRequirements);
const reviewStatuses = new Set(["approved", "blocked"]);
const controlStatuses = new Set(["verified", "blocked"]);
const decisionOutcomes = new Set(["approved", "blocked"]);
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
    throw new Error(`${field} must not contain a placeholder in approved evidence`);
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

function validateRelease(value) {
  const release = assertExactKeys(value, ["revision", "version"], "release");
  const version = assertString(release.version, "release.version");
  const revision = assertString(release.revision, "release.revision");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("release.version must use stable MAJOR.MINOR.PATCH syntax");
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("release.revision must be a full lowercase Git commit");
  }
  return { revision, version };
}

function validateScope(value) {
  const scope = assertExactKeys(
    value,
    [
      "accessModel",
      "audience",
      "financialAdviceProvided",
      "financialReturnsPromised",
      "purpose",
      "realAssetsAccepted",
      "valueModel",
    ],
    "scope",
  );
  const requiredValues = {
    accessModel: "deny-by-default",
    audience: "invited-testers",
    financialAdviceProvided: false,
    financialReturnsPromised: false,
    purpose: "centralized-exchange-learning-platform",
    realAssetsAccepted: false,
    valueModel: "simulated-only",
  };
  for (const [field, expected] of Object.entries(requiredValues)) {
    if (scope[field] !== expected) {
      throw new Error(`scope.${field} must equal ${JSON.stringify(expected)}`);
    }
  }
}

function validateDeploymentControls(value) {
  if (!Array.isArray(value)) throw new Error("deploymentControls must be an array");
  const seen = new Set();
  let blocked = 0;
  for (const [index, item] of value.entries()) {
    const control = assertExactKeys(
      item,
      ["evidence", "id", "notes", "requiredSetting", "status"],
      `deploymentControls[${String(index)}]`,
    );
    const id = assertString(control.id, `deploymentControls[${String(index)}].id`);
    const requirement = deploymentRequirementById.get(id);
    if (requirement === undefined) throw new Error(`Unknown deployment control: ${id}`);
    if (seen.has(id)) throw new Error(`Duplicate deployment control: ${id}`);
    seen.add(id);
    if (control.requiredSetting !== requirement.requiredSetting) {
      throw new Error(`${id}.requiredSetting must equal ${requirement.requiredSetting}`);
    }
    if (!controlStatuses.has(control.status)) {
      throw new Error(`${id}.status must be verified or blocked`);
    }
    const verified = control.status === "verified";
    assertSafeString(control.notes, `${id}.notes`, { allowPlaceholder: !verified });
    validateEvidence(control.evidence, `${id}.evidence`, {
      allowPlaceholder: !verified,
      required: verified,
    });
    if (!verified) blocked += 1;
  }
  const missing = deploymentControlRequirements
    .map((requirement) => requirement.id)
    .filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`Missing deployment controls: ${missing.join(", ")}`);
  if (seen.size !== deploymentControlRequirements.length) {
    throw new Error("deploymentControls must contain exactly the required controls");
  }
  return blocked;
}

function validateDisclosures(value) {
  if (!Array.isArray(value)) throw new Error("disclosures must be an array");
  const seen = new Set();
  let blocked = 0;
  for (const [index, item] of value.entries()) {
    const disclosure = assertExactKeys(
      item,
      ["evidence", "id", "notes", "owner", "status"],
      `disclosures[${String(index)}]`,
    );
    const id = assertString(disclosure.id, `disclosures[${String(index)}].id`);
    if (!disclosureIds.has(id)) throw new Error(`Unknown disclosure requirement: ${id}`);
    if (seen.has(id)) throw new Error(`Duplicate disclosure requirement: ${id}`);
    seen.add(id);
    if (!reviewStatuses.has(disclosure.status)) {
      throw new Error(`${id}.status must be approved or blocked`);
    }
    const approved = disclosure.status === "approved";
    assertSafeString(disclosure.owner, `${id}.owner`, { allowPlaceholder: !approved });
    assertSafeString(disclosure.notes, `${id}.notes`, { allowPlaceholder: !approved });
    validateEvidence(disclosure.evidence, `${id}.evidence`, {
      allowPlaceholder: !approved,
      required: approved,
    });
    if (!approved) blocked += 1;
  }
  const missing = disclosureRequirements.filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`Missing disclosure requirements: ${missing.join(", ")}`);
  if (seen.size !== disclosureRequirements.length) {
    throw new Error("disclosures must contain exactly the required requirements");
  }
  return blocked;
}

function validateDataHandling(value) {
  const dataHandling = assertExactKeys(
    value,
    ["categories", "evidence", "notes", "owner", "references", "status"],
    "dataHandling",
  );
  if (!reviewStatuses.has(dataHandling.status)) {
    throw new Error("dataHandling.status must be approved or blocked");
  }
  const approved = dataHandling.status === "approved";
  if (!Array.isArray(dataHandling.categories))
    throw new Error("dataHandling.categories must be an array");
  const categorySet = new Set(dataHandling.categories);
  if (categorySet.size !== dataHandling.categories.length) {
    throw new Error("dataHandling.categories must not contain duplicates");
  }
  const missing = dataCategories.filter((category) => !categorySet.has(category));
  const unknown = dataHandling.categories.filter((category) => !dataCategories.includes(category));
  if (missing.length > 0 || unknown.length > 0 || categorySet.size !== dataCategories.length) {
    throw new Error("dataHandling.categories must contain exactly the required data categories");
  }
  assertSafeString(dataHandling.owner, "dataHandling.owner", { allowPlaceholder: !approved });
  assertSafeString(dataHandling.notes, "dataHandling.notes", { allowPlaceholder: !approved });
  const references = assertExactKeys(
    dataHandling.references,
    ["deletionProcedure", "privacyNotice", "retentionPolicy", "subprocessorReview"],
    "dataHandling.references",
  );
  for (const [field, reference] of Object.entries(references)) {
    assertSafeString(reference, `dataHandling.references.${field}`, {
      allowPlaceholder: !approved,
    });
  }
  validateEvidence(dataHandling.evidence, "dataHandling.evidence", {
    allowPlaceholder: !approved,
    required: approved,
  });
  return approved ? 0 : 1;
}

function validateSupport(value) {
  const support = assertExactKeys(
    value,
    ["contactPath", "evidence", "incidentEscalation", "notes", "owner", "status", "tested"],
    "support",
  );
  if (!reviewStatuses.has(support.status)) {
    throw new Error("support.status must be approved or blocked");
  }
  if (typeof support.tested !== "boolean") throw new Error("support.tested must be a boolean");
  const approved = support.status === "approved";
  if (approved && !support.tested)
    throw new Error("Approved support must have a tested contact path");
  assertSafeString(support.owner, "support.owner", { allowPlaceholder: !approved });
  assertSafeString(support.contactPath, "support.contactPath", { allowPlaceholder: !approved });
  assertSafeString(support.incidentEscalation, "support.incidentEscalation", {
    allowPlaceholder: !approved,
  });
  assertSafeString(support.notes, "support.notes", { allowPlaceholder: !approved });
  validateEvidence(support.evidence, "support.evidence", {
    allowPlaceholder: !approved,
    required: approved,
  });
  return approved ? 0 : 1;
}

function validateDecision(value, now) {
  const decision = assertExactKeys(
    value,
    ["decidedAt", "decidedBy", "outcome", "reason"],
    "decision",
  );
  if (!decisionOutcomes.has(decision.outcome)) {
    throw new Error("decision.outcome must be approved or blocked");
  }
  const decidedAt = parseTimestamp(decision.decidedAt, "decision.decidedAt");
  if (decidedAt > now) throw new Error("decision.decidedAt cannot be in the future");
  const approved = decision.outcome === "approved";
  assertSafeString(decision.decidedBy, "decision.decidedBy", { allowPlaceholder: !approved });
  assertSafeString(decision.reason, "decision.reason", { allowPlaceholder: !approved });
  return { decidedAt, outcome: decision.outcome };
}

export function validateProductScopeApproval(value, { now = Date.now() } = {}) {
  const record = assertExactKeys(
    value,
    [
      "approvalId",
      "dataHandling",
      "decision",
      "deploymentControls",
      "disclosures",
      "environment",
      "release",
      "schemaVersion",
      "scope",
      "support",
    ],
    "product scope approval",
  );
  if (record.schemaVersion !== 1) throw new Error("schemaVersion must equal 1");
  const approvalId = assertString(record.approvalId, "approvalId");
  if (!/^scope-\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(approvalId)) {
    throw new Error("approvalId must use scope-YYYY-MM-DD-slug syntax");
  }
  if (record.environment !== "staging" && record.environment !== "production") {
    throw new Error("environment must be staging or production");
  }
  const release = validateRelease(record.release);
  validateScope(record.scope);
  const blockedDeploymentControls = validateDeploymentControls(record.deploymentControls);
  const blockedDisclosures = validateDisclosures(record.disclosures);
  const blockedDataHandlingReviews = validateDataHandling(record.dataHandling);
  const blockedSupportReviews = validateSupport(record.support);
  const decision = validateDecision(record.decision, now);

  const blockingItems =
    blockedDeploymentControls +
    blockedDisclosures +
    blockedDataHandlingReviews +
    blockedSupportReviews;
  if (decision.outcome === "approved" && blockingItems > 0) {
    throw new Error("An approved decision cannot contain blocked product-scope requirements");
  }
  if (decision.outcome === "approved" && /^0+$/.test(release.revision)) {
    throw new Error("An approved decision cannot use the placeholder release revision");
  }
  if (decision.outcome === "blocked" && blockingItems === 0) {
    throw new Error("A blocked decision must identify at least one blocked requirement");
  }

  const expiresAt = decision.decidedAt + maximumEvidenceAgeDays * millisecondsPerDay;
  const readinessEligible = decision.outcome === "approved" && now < expiresAt;
  return Object.freeze({
    approvalId,
    blockingItems,
    environment: record.environment,
    expiresAt: new Date(expiresAt).toISOString(),
    observedAt: new Date(decision.decidedAt).toISOString(),
    outcome: decision.outcome,
    readinessEligible,
    releaseRevision: release.revision,
    releaseVersion: release.version,
  });
}

export async function validateProductScopeApprovalFile(path, options) {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  return validateProductScopeApproval(parsed, options);
}

export function parseProductScopeApprovalPath(arguments_) {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (normalized.length !== 1) {
    throw new Error("Usage: pnpm product:scope:validate -- <product-scope-approval.json>");
  }
  return normalized[0];
}

async function main(arguments_) {
  const report = await validateProductScopeApprovalFile(parseProductScopeApprovalPath(arguments_));
  process.stdout.write(
    `${JSON.stringify({ event: "operations.product_scope.validated", report })}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `Atlas product scope validation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
