import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readinessControls } from "../operations/validate-readiness-record.mjs";
import {
  createRenderBlueprint,
  serializeRenderBlueprint,
  validateStagingDeploymentInput,
} from "./generate-render-blueprint.mjs";

const now = new Date("2026-08-31T00:30:00.000Z");
const requiredControls = new Set([
  "runtime-database-selection",
  "candidate-vulnerability-scan",
  "release-provenance",
]);

function createReadinessRecord() {
  return {
    schemaVersion: 2,
    environment: "staging",
    release: {
      version: "0.1.0",
      revision: "a".repeat(40),
      apiImageDigest: `sha256:${"b".repeat(64)}`,
      webImageDigest: `sha256:${"c".repeat(64)}`,
      metricsCollectorImageDigest: `sha256:${"d".repeat(64)}`,
    },
    decision: {
      outcome: "no-go",
      decidedAt: "2026-08-31T00:15:00.000Z",
      decidedBy: "Atlas maintainer",
      reason: "Provisioning inputs are ready; live staging controls remain blocked.",
    },
    controls: readinessControls.map(({ id }) =>
      requiredControls.has(id)
        ? {
            id,
            status: "passed",
            observedAt: "2026-08-31T00:00:00.000Z",
            expiresAt: "2026-09-01T00:00:00.000Z",
            evidence: [`evidence/${id}.json`],
          }
        : { id, status: "blocked", notes: "Requires the live staging environment." },
    ),
  };
}

function createInput() {
  return {
    schemaVersion: 1,
    domain: {
      registrableDomain: "atlas-owner.dev",
      webHostname: "app.staging.atlas-owner.dev",
      apiHostname: "api.staging.atlas-owner.dev",
    },
    cloudflareAccess: {
      teamDomain: "https://atlas-team.cloudflareaccess.com",
      audience: "a".repeat(64),
    },
    grafanaCloud: {
      prometheusUrl: "https://prometheus-prod-01-prod-ap-south-1.grafana.net/api/prom/push",
      prometheusUsername: "123456",
    },
    smtp: {
      host: "smtp.mail-provider.dev",
      port: 587,
      secure: false,
      from: "Atlas Exchange <staging@atlas-owner.dev>",
      authentication: "required",
    },
    registry: { visibility: "public" },
    costApproval: {
      currency: "USD",
      maximumMonthlyCostCents: 20_000,
      approvedBy: "Atlas owner",
      approvedAt: "2026-08-31T00:00:00.000Z",
      expiresAt: "2026-09-30T00:00:00.000Z",
    },
  };
}

describe("Render staging Blueprint generation", () => {
  it("requires exact deployment inputs and fresh release evidence", () => {
    const validated = validateStagingDeploymentInput(createInput(), createReadinessRecord(), now);
    assert.equal(validated.webHostname, "app.staging.atlas-owner.dev");
    assert.equal(validated.apiHostname, "api.staging.atlas-owner.dev");
    assert.equal(validated.release.version, "0.1.0");
    assert.equal(validated.registry.visibility, "public");
  });

  it("rejects placeholders, cross-site origins, and reserved provider domains", () => {
    const placeholder = createInput();
    placeholder.domain.webHostname = "<staging-web-hostname>";
    assert.throws(
      () => validateStagingDeploymentInput(placeholder, createReadinessRecord(), now),
      /fully qualified hostname/,
    );

    const crossSite = createInput();
    crossSite.domain.apiHostname = "api.other-owner.dev";
    assert.throws(
      () => validateStagingDeploymentInput(crossSite, createReadinessRecord(), now),
      /distinct children/,
    );

    const reserved = createInput();
    reserved.domain.registrableDomain = "example.com";
    reserved.domain.webHostname = "app.example.com";
    reserved.domain.apiHostname = "api.example.com";
    assert.throws(
      () => validateStagingDeploymentInput(reserved, createReadinessRecord(), now),
      /Atlas-owned/,
    );

    assert.throws(
      () =>
        validateStagingDeploymentInput(
          { ...createInput(), unexpected: "ignored-value" },
          createReadinessRecord(),
          now,
        ),
      /must contain exactly/,
    );
  });

  it("rejects stale prerequisite evidence and invalid cost approval", () => {
    const staleReadiness = createReadinessRecord();
    staleReadiness.controls.find(
      (control) => control.id === "candidate-vulnerability-scan",
    ).expiresAt = "2026-08-31T00:20:00.000Z";
    assert.throws(
      () => validateStagingDeploymentInput(createInput(), staleReadiness, now),
      /expired at Blueprint generation/,
    );

    const expiredApproval = createInput();
    expiredApproval.costApproval.expiresAt = "2026-08-31T00:20:00.000Z";
    assert.throws(
      () => validateStagingDeploymentInput(expiredApproval, createReadinessRecord(), now),
      /costApproval has expired/,
    );
  });

  it("creates the accepted fixed topology without embedding external secrets", () => {
    const configuration = validateStagingDeploymentInput(
      createInput(),
      createReadinessRecord(),
      now,
    );
    const blueprint = createRenderBlueprint(configuration);
    const environment = blueprint.projects[0].environments[0];
    assert.deepEqual(
      environment.services.map((service) => [service.name, service.type, service.plan]),
      [
        ["atlas-api-staging", "web", "1c-2g"],
        ["atlas-web-staging", "web", "0.5c-512mb"],
        ["atlas-metrics-collector-staging", "pserv", "0.5c-512mb"],
      ],
    );
    assert.equal(environment.networking.isolation, "enabled");
    assert.equal(environment.permissions.protection, "enabled");
    assert.deepEqual(environment.databases, [
      {
        name: "atlas-postgres-staging",
        plan: "0.5c-1g",
        region: "singapore",
        postgresMajorVersion: "18",
        databaseName: "atlas",
        user: "atlas",
        diskSizeGB: 15,
        storageAutoscalingEnabled: false,
        ipAllowList: [],
        connectionPool: "none",
      },
    ]);

    const [api, web, collector] = environment.services;
    assert.equal(api.renderSubdomainPolicy, "disabled");
    assert.equal(web.renderSubdomainPolicy, "disabled");
    assert.equal(collector.healthCheckPath, undefined);
    assert.equal(api.image.url.endsWith(`@sha256:${"b".repeat(64)}`), true);
    assert.equal(web.image.url.endsWith(`@sha256:${"c".repeat(64)}`), true);
    assert.equal(collector.image.url.endsWith(`@sha256:${"d".repeat(64)}`), true);
    assert.deepEqual(
      collector.envVars.find((variable) => variable.key === "ATLAS_METRICS_TARGET").fromService,
      { name: "atlas-api-staging", type: "web", property: "hostport" },
    );
    assert.deepEqual(
      collector.envVars.find((variable) => variable.key === "METRICS_BEARER_TOKEN").fromService,
      { name: "atlas-api-staging", type: "web", envVarKey: "METRICS_BEARER_TOKEN" },
    );
    assert.equal(
      collector.envVars.find((variable) => variable.key === "GRAFANA_CLOUD_METRICS_TOKEN").sync,
      false,
    );
    assert.deepEqual(
      api.envVars.find((variable) => variable.key === "METRICS_BEARER_TOKEN"),
      { key: "METRICS_BEARER_TOKEN", generateValue: true },
    );
    assert.deepEqual(
      api.envVars.find((variable) => variable.key === "CSRF_HMAC_KEY"),
      { key: "CSRF_HMAC_KEY", sync: false },
    );
  });

  it("adds only a named read-only registry reference for private images", () => {
    const input = createInput();
    input.registry = { visibility: "private", credentialName: "atlas-ghcr-read-only" };
    const configuration = validateStagingDeploymentInput(input, createReadinessRecord(), now);
    const environment = createRenderBlueprint(configuration).projects[0].environments[0];
    for (const service of environment.services) {
      assert.deepEqual(service.image.creds, {
        fromRegistryCreds: { name: "atlas-ghcr-read-only" },
      });
    }
  });

  it("serializes a deterministic reviewable YAML document", () => {
    const configuration = validateStagingDeploymentInput(
      createInput(),
      createReadinessRecord(),
      now,
    );
    const yaml = serializeRenderBlueprint(createRenderBlueprint(configuration));
    assert.match(yaml, /^previews:\n {2}generation: "off"\nprojects:/);
    assert.match(yaml, /renderSubdomainPolicy: "disabled"/);
    assert.match(yaml, /ipAllowList: \[\]/);
    assert.match(yaml, /generateValue: true/);
    assert.match(yaml, /sync: false/);
    assert.doesNotMatch(yaml, /:latest|<(?:exact|replace|placeholder)[^>]*>/i);
    assert.doesNotMatch(yaml, /key: "(?:SMTP_PASSWORD|GRAFANA_CLOUD_METRICS_TOKEN)"\n\s+value:/);
  });
});
