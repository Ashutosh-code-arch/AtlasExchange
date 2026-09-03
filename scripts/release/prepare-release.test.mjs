import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  createReleaseMetadata,
  createReleaseMatrix,
  normalizeRegistryNamespace,
  parseReleaseTag,
  serializeGitHubOutputs,
  validatePackageVersion,
} from "./prepare-release.mjs";

describe("release preparation", () => {
  it("creates an API-only matrix without silently adding other artifacts", () => {
    assert.deepEqual(createReleaseMatrix("api"), {
      include: [{ application: "api", image: "atlas-api", dockerfile: "apps/api/Dockerfile" }],
    });
    assert.equal(createReleaseMatrix().include.length, 3);
    assert.throws(() => createReleaseMatrix("untrusted"), /Unknown release application/);
  });

  it("keeps explicit release intent and per-image fail-closed publication ordering", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/publish-release-images.yml", import.meta.url),
      "utf8",
    );
    assert.match(workflow, /workflow_dispatch:/);
    assert.doesNotMatch(workflow, /types: \[published\]/);
    assert.match(workflow, /fail-fast: false/);
    assert.doesNotMatch(workflow, /continue-on-error|\|\| true/);
    assert.match(workflow, /for platform in linux\/amd64 linux\/arm64/);
    assert.match(workflow, /node scripts\/security\/scan-container-images.mjs "\$APPLICATION"/);
    const scan = workflow.indexOf("- name: Build and scan both runtime architectures");
    const login = workflow.indexOf("- name: Log in to GitHub Container Registry");
    const publish = workflow.indexOf("- name: Build and publish");
    assert.ok(scan > 0 && login > scan && publish > login);
    assert.match(workflow, /ref: \$\{\{ needs.prepare.outputs.revision \}\}/);
    assert.match(workflow, /provenance: mode=max/);
    assert.match(workflow, /sbom: true/);
  });
  it("accepts stable semantic release tags", () => {
    assert.equal(parseReleaseTag("v0.1.0"), "0.1.0");
    assert.equal(parseReleaseTag("v12.34.56"), "12.34.56");
  });

  it("rejects ambiguous, prefixed, and prerelease tags", () => {
    for (const tag of ["1.2.3", "v01.2.3", "v1.2", "v1.2.3-rc.1", "release-v1.2.3"]) {
      assert.throws(() => parseReleaseTag(tag), /vMAJOR\.MINOR\.PATCH/);
    }
  });

  it("normalizes only valid registry namespaces", () => {
    assert.equal(normalizeRegistryNamespace("Ashutosh-code-arch"), "ashutosh-code-arch");
    assert.throws(() => normalizeRegistryNamespace("invalid_owner"), /registry namespace/);
  });

  it("requires the source manifest to match the release tag", () => {
    assert.doesNotThrow(() => validatePackageVersion("1.2.3", "1.2.3"));
    assert.throws(() => validatePackageVersion("1.2.3", "1.2.4"), /do not match/);
  });

  it("creates newline-safe immutable workflow outputs", () => {
    const metadata = createReleaseMetadata({
      created: "2026-08-30T12:00:00+00:00",
      owner: "Atlas-Owner",
      revision: "b".repeat(40),
      tag: "v1.2.3",
    });

    assert.deepEqual(metadata, {
      created: "2026-08-30T12:00:00+00:00",
      registryNamespace: "atlas-owner",
      revision: "b".repeat(40),
      version: "1.2.3",
    });
    assert.equal(
      serializeGitHubOutputs(metadata),
      `created=2026-08-30T12:00:00+00:00\nregistry_namespace=atlas-owner\nrevision=${"b".repeat(40)}\nversion=1.2.3\nmatrix=${JSON.stringify(createReleaseMatrix())}\n`,
    );
  });
});
