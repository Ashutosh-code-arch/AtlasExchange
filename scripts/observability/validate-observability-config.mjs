import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, "../..");

const durationPattern = /^(?:[1-9]\d*)(?:s|m|h)$/;
const alertNamePattern = /^Atlas[A-Z][A-Za-z0-9]+$/;

function requireObject(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireDuration(value, name) {
  const duration = requireString(value, name);
  if (!durationPattern.test(duration)) throw new Error(`${name} must be a bounded duration`);
  return duration;
}

function requireStagingExpression(value, name) {
  const expression = requireString(value, name);
  if (!expression.includes('environment="staging"')) {
    throw new Error(`${name} must select the staging environment explicitly`);
  }
  if (/<[^>]+>|example\.|credential|secret|token/i.test(expression)) {
    throw new Error(`${name} contains a placeholder or credential-like value`);
  }
  return expression;
}

export function validateAlertPolicy(input) {
  const policy = requireObject(input, "alert policy");
  if (policy.schemaVersion !== 1) throw new Error("alert policy schemaVersion must be 1");
  if (policy.environment !== "staging") throw new Error("alert policy environment must be staging");
  requireDuration(policy.evaluationInterval, "evaluationInterval");

  if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
    throw new Error("alert policy must contain active rules");
  }

  const ruleNames = new Set();
  for (const [index, candidate] of policy.rules.entries()) {
    const rule = requireObject(candidate, `rules[${index}]`);
    const name = requireString(rule.name, `rules[${index}].name`);
    if (!alertNamePattern.test(name)) throw new Error(`${name} is not a bounded Atlas alert name`);
    if (ruleNames.has(name)) throw new Error(`duplicate alert rule: ${name}`);
    ruleNames.add(name);
    if (!new Set(["sev1", "sev2", "sev3", "sev4"]).has(rule.severity)) {
      throw new Error(`${name} has an invalid severity`);
    }
    requireStagingExpression(rule.expression, `${name}.expression`);
    requireDuration(rule.pendingFor, `${name}.pendingFor`);
    if (rule.noDataState !== "Alerting" || rule.errorState !== "Alerting") {
      throw new Error(`${name} must fail closed on missing data and evaluation errors`);
    }
    requireString(rule.owner, `${name}.owner`);
    requireString(rule.runbookAnchor, `${name}.runbookAnchor`);
    requireString(rule.action, `${name}.action`);
  }

  if (!Array.isArray(policy.baselineCandidates) || policy.baselineCandidates.length === 0) {
    throw new Error("alert policy must preserve baseline-dependent candidates");
  }
  for (const [index, candidateValue] of policy.baselineCandidates.entries()) {
    const candidate = requireObject(candidateValue, `baselineCandidates[${index}]`);
    requireString(candidate.signal, `baselineCandidates[${index}].signal`);
    requireStagingExpression(candidate.query, `baselineCandidates[${index}].query`);
    requireString(
      candidate.activationRequirement,
      `baselineCandidates[${index}].activationRequirement`,
    );
  }

  const synthetic = requireObject(policy.externalSynthetic, "externalSynthetic");
  if (synthetic.path !== "/health/ready" || synthetic.expectedStatus !== 200) {
    throw new Error("external synthetic must probe successful API readiness");
  }
  requireDuration(synthetic.interval, "externalSynthetic.interval");
  requireDuration(synthetic.timeout, "externalSynthetic.timeout");
  if (
    !Number.isInteger(synthetic.failedExecutionsBeforeAlert) ||
    synthetic.failedExecutionsBeforeAlert < 2
  ) {
    throw new Error("external synthetic must tolerate one isolated execution failure");
  }
  if (!Number.isInteger(synthetic.locations) || synthetic.locations < 2) {
    throw new Error("external synthetic must distinguish one probe-location failure");
  }
  if (synthetic.noDataState !== "Alerting") {
    throw new Error("external synthetic must alert on missing observations");
  }
  requireString(synthetic.owner, "externalSynthetic.owner");
  requireString(synthetic.runbookAnchor, "externalSynthetic.runbookAnchor");

  return Object.freeze({
    activeRules: policy.rules.length,
    baselineCandidates: policy.baselineCandidates.length,
  });
}

export function validateDashboard(input) {
  const dashboard = requireObject(input, "dashboard");
  if (dashboard.uid !== "atlas-staging-operations") {
    throw new Error("dashboard uid must remain stable");
  }
  if (!Array.isArray(dashboard.panels) || dashboard.panels.length === 0) {
    throw new Error("dashboard must contain panels");
  }

  const panelIds = new Set();
  let queryCount = 0;
  for (const [index, candidate] of dashboard.panels.entries()) {
    const panel = requireObject(candidate, `panels[${index}]`);
    if (!Number.isInteger(panel.id) || panel.id <= 0 || panelIds.has(panel.id)) {
      throw new Error(`panels[${index}] has an invalid or duplicate id`);
    }
    panelIds.add(panel.id);
    requireString(panel.title, `panels[${index}].title`);
    if (!Array.isArray(panel.targets) || panel.targets.length === 0) {
      throw new Error(`panels[${index}] must contain queries`);
    }
    for (const [targetIndex, candidateTarget] of panel.targets.entries()) {
      const target = requireObject(candidateTarget, `panels[${index}].targets[${targetIndex}]`);
      requireStagingExpression(target.expr, `panels[${index}].targets[${targetIndex}].expr`);
      queryCount += 1;
    }
  }

  return Object.freeze({ panels: dashboard.panels.length, queries: queryCount });
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(repositoryDirectory, relativePath), "utf8"));
}

export function validateRepositoryObservabilityConfiguration() {
  const alertPolicy = validateAlertPolicy(
    readJson("infra/observability/grafana/alert-policy.json"),
  );
  const dashboard = validateDashboard(
    readJson("infra/observability/grafana/staging-overview-dashboard.json"),
  );
  return Object.freeze({ alertPolicy, dashboard });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = validateRepositoryObservabilityConfiguration();
    process.stdout.write(
      `${JSON.stringify({ event: "observability.config.validated", ...result })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `Atlas observability configuration validation failed: ${
        error instanceof Error ? error.message : "unknown error"
      }\n`,
    );
    process.exitCode = 1;
  }
}
