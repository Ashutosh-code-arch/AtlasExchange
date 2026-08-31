import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDemoDeploymentManifest,
  serializeDemoDeploymentManifest,
  validateDemoDeploymentInput,
} from "./generate-demo-deployment.mjs";

function input() {
  return {
    schemaVersion: 1,
    environment: "demo",
    release: {
      version: "0.1.2",
      revision: "a".repeat(40),
      apiImageDigest: `sha256:${"b".repeat(64)}`,
    },
    cloudflare: {
      plan: "free",
      paidOverage: false,
      workerName: "atlas-exchange-demo",
      publicOrigin: "https://atlas-exchange-demo.owner.workers.dev",
      workerSourceRevision: "a".repeat(40),
      previewUrls: false,
      customDomains: false,
      accessApplicationTarget: "worker-name",
      exactEmailAllowPolicy: true,
      accessTeamDomain: "https://atlas-team.cloudflareaccess.com",
      accessAudience: "c".repeat(64),
    },
    render: {
      plan: "free",
      paidFeatures: false,
      serviceName: "atlas-api-demo",
      apiOrigin: "https://atlas-api-demo.onrender.com",
      region: "singapore",
      instances: 1,
    },
    neon: {
      plan: "free",
      paidFeatures: false,
      postgresMajorVersion: 18,
      schemaVersion: 15,
    },
    cost: {
      currency: "USD",
      maximumMonthlyCostCents: 0,
      paymentMethodRequired: false,
    },
  };
}

describe("zero-cost demo deployment generation", () => {
  it("validates an exact immutable zero-cost topology", () => {
    const validated = validateDemoDeploymentInput(input());
    assert.equal(validated.cloudflare.workerName, "atlas-exchange-demo");
    assert.equal(validated.render.serviceName, "atlas-api-demo");
    assert.equal(validated.neon.schemaVersion, 15);
    assert.equal(validated.release.revision, "a".repeat(40));
  });

  it("rejects paid, public, mutable, and cross-provider topology drift", () => {
    for (const mutate of [
      (value) => (value.cost.maximumMonthlyCostCents = 1),
      (value) => (value.cloudflare.plan = "paid"),
      (value) => (value.cloudflare.paidOverage = true),
      (value) => (value.cloudflare.previewUrls = true),
      (value) => (value.cloudflare.customDomains = true),
      (value) => (value.cloudflare.exactEmailAllowPolicy = false),
      (value) => (value.cloudflare.workerSourceRevision = "d".repeat(40)),
      (value) => (value.cloudflare.publicOrigin = "https://other.owner.workers.dev"),
      (value) => (value.render.plan = "starter"),
      (value) => (value.render.instances = 2),
      (value) => (value.render.apiOrigin = "https://atlas-api-demo.onrender.com:8443"),
      (value) => (value.render.apiOrigin = "https://other.onrender.com"),
      (value) => (value.neon.plan = "launch"),
      (value) => (value.neon.schemaVersion = 14),
    ]) {
      const candidate = input();
      mutate(candidate);
      assert.throws(() => validateDemoDeploymentInput(candidate));
    }
  });

  it("rejects placeholders, secrets, invalid release identities, and unknown fields", () => {
    const placeholder = input();
    placeholder.cloudflare.publicOrigin = "https://<worker>.workers.dev";
    assert.throws(() => validateDemoDeploymentInput(placeholder), /HTTPS origin/);

    const mutableImage = input();
    mutableImage.release.apiImageDigest = "atlas-api:latest";
    assert.throws(() => validateDemoDeploymentInput(mutableImage), /apiImageDigest is invalid/);

    const prerelease = input();
    prerelease.release.version = "0.1.2-rc.1";
    assert.throws(() => validateDemoDeploymentInput(prerelease), /release.version is invalid/);

    const secret = { ...input(), databaseUrl: "postgresql://credential@database.invalid/atlas" };
    assert.throws(() => validateDemoDeploymentInput(secret), /must contain exactly/);
  });

  it("emits a deterministic manifest with names, not secret values", () => {
    const manifest = createDemoDeploymentManifest(validateDemoDeploymentInput(input()));
    assert.equal(manifest.recurringCost.maximumMonthlyCostCents, 0);
    assert.equal(
      manifest.release.apiImage,
      `ghcr.io/ashutosh-code-arch/atlas-api@sha256:${"b".repeat(64)}`,
    );
    assert.equal(manifest.cloudflare.access.applicationTarget, "worker-name");
    assert.equal(manifest.cloudflare.bindings.ATLAS_ENV, "demo");
    assert.equal(manifest.render.publicEnvironment.REFERENCE_MARKET_DATA_ENABLED, "true");
    assert.deepEqual(manifest.render.requiredSecretMaterial, [
      "DATABASE_URL",
      "CSRF_HMAC_KEY",
      "METRICS_BEARER_TOKEN",
      "atlas-password-blocklist.sha256",
    ]);

    const serialized = serializeDemoDeploymentManifest(manifest);
    assert.equal(serialized, serializeDemoDeploymentManifest(manifest));
    assert.doesNotMatch(serialized, /postgresql:\/\//);
    assert.doesNotMatch(serialized, /invited-reviewer@/);
  });
});
