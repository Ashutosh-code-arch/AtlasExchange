import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDatabaseUpdateArguments,
  createImageSaveArguments,
  createScanArguments,
  runtimeImages,
  scannerImage,
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
    assert.ok(arguments_.includes("/tmp:rw,noexec,nosuid,mode=1777,size=512m"));
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

  it("saves and scans exactly the API and web runtime images", () => {
    assert.deepEqual(runtimeImages, ["atlas-api:local", "atlas-web:local"]);
    assert.deepEqual(createImageSaveArguments("atlas-api:local", archivePath), [
      "image",
      "save",
      "--output",
      archivePath,
      "atlas-api:local",
    ]);
  });
});
