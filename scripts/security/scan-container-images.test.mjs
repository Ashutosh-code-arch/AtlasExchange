import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDatabaseUpdateArguments,
  createImageSaveArguments,
  createScanArguments,
  renderGrypeExceptionConfig,
  runtimeImages,
  scannerImage,
  validateVulnerabilityExceptions,
} from "./scan-container-images.mjs";

const cacheDirectory = "/tmp/atlas-cache";
const archivePath = "/tmp/atlas-image.tar";
const user = "1000:1000";

describe("container vulnerability scanning", () => {
  it("pins the scanner by readable version and immutable digest", () => {
    assert.match(scannerImage, /^anchore\/grype:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  });

  it("updates only the isolated scanner database cache", () => {
    const arguments_ = createDatabaseUpdateArguments(cacheDirectory, user);
    assert.deepEqual(arguments_.slice(-3), [scannerImage, "db", "update"]);
    assert.ok(arguments_.includes(`${cacheDirectory}:/scanner/.cache/grype`));
    assert.ok(arguments_.includes("/tmp:rw,noexec,nosuid,mode=1777,size=1g"));
    assert.equal(
      arguments_.some((argument) => argument.includes("docker.sock")),
      false,
    );
    assert.equal(
      arguments_.some((argument) => argument.includes("/repo")),
      false,
    );
  });

  it("scans an archive offline and fails on high severity", () => {
    const arguments_ = createScanArguments(archivePath, cacheDirectory, user);
    assert.ok(arguments_.includes("none"));
    assert.ok(arguments_.includes(`${archivePath}:/scan/image.tar:ro`));
    assert.ok(arguments_.includes(`${cacheDirectory}:/scanner/.cache/grype:ro`));
    assert.deepEqual(arguments_.slice(-3), ["docker-archive:/scan/image.tar", "--fail-on", "high"]);
    assert.equal(
      arguments_.some((argument) => argument.includes("docker.sock")),
      false,
    );
  });

  it("mounts a narrow scanner configuration only when an image has an exception", () => {
    const configPath = "/tmp/atlas-grype.yaml";
    const arguments_ = createScanArguments(archivePath, cacheDirectory, user, configPath);
    assert.ok(arguments_.includes(`${configPath}:/scan/grype.yaml:ro`));
    assert.ok(arguments_.includes("--config"));
    assert.ok(arguments_.includes("/scan/grype.yaml"));
  });

  it("validates bounded exceptions and renders exact package matching", () => {
    const manifest = {
      schemaVersion: 1,
      exceptions: [
        {
          advisory: "GO-2026-4887",
          image: "atlas-metrics-collector:local",
          package: {
            name: "github.com/docker/docker",
            version: "v28.5.2+incompatible",
            type: "go-module",
            location: "/bin/alloy",
          },
          affectedPath: "Docker Engine daemon AuthZ request forwarding",
          rationale: "The image is not a Docker Engine daemon.",
          compensatingControls: ["No Docker socket is mounted."],
          owner: "Atlas maintainer",
          approvedAt: "2026-08-31T12:00:00.000Z",
          expiresAt: "2026-09-30T12:00:00.000Z",
          reviewSource: "https://example.com/advisory",
        },
      ],
    };
    const exceptions = validateVulnerabilityExceptions(
      manifest,
      new Date("2026-09-01T00:00:00.000Z"),
    );
    const configuration = renderGrypeExceptionConfig(exceptions);
    assert.match(configuration, /vulnerability: "GO-2026-4887"/);
    assert.match(configuration, /name: "github.com\/docker\/docker"/);
    assert.match(configuration, /version: "v28\.5\.2\+incompatible"/);
    assert.match(configuration, /type: "go-module"/);
    assert.doesNotMatch(configuration, /location:/);
  });

  it("rejects expired and overlong exceptions", () => {
    const createManifest = (expiresAt) => ({
      schemaVersion: 1,
      exceptions: [
        {
          advisory: "GO-2026-4887",
          image: "atlas-metrics-collector:local",
          package: {
            name: "github.com/docker/docker",
            version: "v28.5.2+incompatible",
            type: "go-module",
            location: "/bin/alloy",
          },
          affectedPath: "Docker Engine daemon AuthZ request forwarding",
          rationale: "The image is not a Docker Engine daemon.",
          compensatingControls: ["No Docker socket is mounted."],
          owner: "Atlas maintainer",
          approvedAt: "2026-08-31T12:00:00.000Z",
          expiresAt,
          reviewSource: "https://example.com/advisory",
        },
      ],
    });
    assert.throws(
      () =>
        validateVulnerabilityExceptions(
          createManifest("2026-09-30T12:00:00.000Z"),
          new Date("2026-09-30T12:00:00.000Z"),
        ),
      /has expired/,
    );
    assert.throws(
      () =>
        validateVulnerabilityExceptions(
          createManifest("2026-10-01T12:00:00.000Z"),
          new Date("2026-09-01T00:00:00.000Z"),
        ),
      /thirty-day/,
    );
    assert.throws(
      () =>
        validateVulnerabilityExceptions(
          createManifest("2026-09-30T12:00:00.000Z"),
          new Date("2026-08-31T00:00:00.000Z"),
        ),
      /approval is in the future/,
    );
  });

  it("saves and scans exactly the API, web, and collector runtime images", () => {
    assert.deepEqual(runtimeImages, [
      "atlas-api:local",
      "atlas-web:local",
      "atlas-metrics-collector:local",
    ]);
    assert.deepEqual(createImageSaveArguments("atlas-api:local", archivePath), [
      "image",
      "save",
      "--output",
      archivePath,
      "atlas-api:local",
    ]);
  });
});
