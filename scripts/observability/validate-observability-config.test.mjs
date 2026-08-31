import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  validateAlertPolicy,
  validateDashboard,
  validateRepositoryObservabilityConfiguration,
} from "./validate-observability-config.mjs";

function validPolicy() {
  return {
    schemaVersion: 1,
    environment: "staging",
    evaluationInterval: "1m",
    rules: [
      {
        name: "AtlasApiUnavailable",
        severity: "sev2",
        expression: 'up{environment="staging",job="atlas-api"} == 0',
        pendingFor: "2m",
        noDataState: "Alerting",
        errorState: "Alerting",
        owner: "Operations Lead",
        runbookAnchor: "api-unavailable",
        action: "Inspect the service and restore availability.",
      },
    ],
    baselineCandidates: [
      {
        signal: "Latency",
        query: 'atlas_http_request_duration_seconds_count{environment="staging"}',
        activationRequirement: "Measure representative staging traffic first.",
      },
    ],
    externalSynthetic: {
      path: "/health/ready",
      interval: "1m",
      timeout: "10s",
      expectedStatus: 200,
      failedExecutionsBeforeAlert: 2,
      locations: 2,
      noDataState: "Alerting",
      owner: "Operations Lead",
      runbookAnchor: "public-readiness-probe-failed",
    },
  };
}

function validDashboard() {
  return {
    uid: "atlas-staging-operations",
    panels: [
      {
        id: 1,
        title: "Availability",
        targets: [{ expr: 'up{environment="staging",job="atlas-api"}' }],
      },
    ],
  };
}

describe("observability configuration validation", () => {
  it("validates the committed policy and dashboard", () => {
    assert.deepEqual(validateRepositoryObservabilityConfiguration(), {
      alertPolicy: { activeRules: 3, baselineCandidates: 4 },
      dashboard: { panels: 8, queries: 12 },
    });
  });

  it("requires every alert to be scoped, actionable, and fail closed", () => {
    const policy = validPolicy();
    assert.deepEqual(validateAlertPolicy(policy), { activeRules: 1, baselineCandidates: 1 });

    policy.rules[0].expression = "up == 0";
    assert.throws(() => validateAlertPolicy(policy), /staging environment/);

    policy.rules[0].expression = 'up{environment="staging"} == 0';
    policy.rules[0].noDataState = "OK";
    assert.throws(() => validateAlertPolicy(policy), /fail closed/);
  });

  it("requires a readiness probe with failure tolerance and multiple locations", () => {
    const policy = validPolicy();
    policy.externalSynthetic.failedExecutionsBeforeAlert = 1;
    assert.throws(() => validateAlertPolicy(policy), /isolated execution failure/);

    policy.externalSynthetic.failedExecutionsBeforeAlert = 2;
    policy.externalSynthetic.locations = 1;
    assert.throws(() => validateAlertPolicy(policy), /probe-location failure/);
  });

  it("requires stable, unique dashboard panels with staging-scoped queries", () => {
    const dashboard = validDashboard();
    assert.deepEqual(validateDashboard(dashboard), { panels: 1, queries: 1 });

    dashboard.panels.push({
      id: 1,
      title: "Duplicate",
      targets: [{ expr: 'up{environment="staging"}' }],
    });
    assert.throws(() => validateDashboard(dashboard), /duplicate id/);
  });
});
