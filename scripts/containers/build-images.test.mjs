import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createContainerBuildPlan,
  createDockerBuildArguments,
  resolveBuildMetadata,
  parseImageSelection,
  selectContainerImages,
} from "./build-images.mjs";

const metadata = Object.freeze({
  created: "2026-08-30T12:00:00.000Z",
  revision: "a".repeat(40),
  source: "https://github.com/example/atlas",
  version: "1.2.3",
});

describe("container image build metadata", () => {
  it("selects only an explicitly allowlisted application and defaults to all", () => {
    assert.equal(parseImageSelection([]), "all");
    assert.equal(parseImageSelection(["--", "api"]), "api");
    for (const application of ["api", "web", "metrics-collector"]) {
      assert.deepEqual(
        selectContainerImages(application).map((image) => image.tag),
        [`atlas-${application}:local`],
      );
      assert.equal(createContainerBuildPlan(metadata, application).length, 1);
    }
    for (const invalid of ["", "API", "unknown", "api\nweb", "--skip-scan"]) {
      assert.throws(() => parseImageSelection([invalid]), /Unknown release application/);
    }
    assert.throws(() => parseImageSelection(["api", "web"]), /at most one/);
  });
  it("validates explicit deterministic metadata", () => {
    assert.deepEqual(
      resolveBuildMetadata({
        ATLAS_IMAGE_CREATED: metadata.created,
        ATLAS_IMAGE_REVISION: metadata.revision,
        ATLAS_IMAGE_SOURCE: metadata.source,
        ATLAS_IMAGE_VERSION: metadata.version,
      }),
      metadata,
    );
  });

  it("rejects metadata that could alter command structure", () => {
    assert.throws(
      () => resolveBuildMetadata({ ATLAS_IMAGE_VERSION: "1.2.3\n--target=hostile" }),
      /ATLAS_IMAGE_VERSION/,
    );
    assert.throws(
      () => resolveBuildMetadata({ ATLAS_IMAGE_REVISION: "not-a-revision" }),
      /ATLAS_IMAGE_REVISION/,
    );
  });

  it("creates argument arrays without shell interpolation", () => {
    assert.deepEqual(
      createDockerBuildArguments(
        { dockerfile: "apps/api/Dockerfile", tag: "atlas-api:local" },
        metadata,
      ),
      [
        "build",
        "--file",
        "apps/api/Dockerfile",
        "--tag",
        "atlas-api:local",
        "--build-arg",
        "ATLAS_IMAGE_VERSION=1.2.3",
        "--build-arg",
        `ATLAS_IMAGE_REVISION=${"a".repeat(40)}`,
        "--build-arg",
        "ATLAS_IMAGE_CREATED=2026-08-30T12:00:00.000Z",
        "--build-arg",
        "ATLAS_IMAGE_SOURCE=https://github.com/example/atlas",
        ".",
      ],
    );
  });

  it("builds exactly the API, web, and metrics-collector local image plans", () => {
    const plan = createContainerBuildPlan(metadata);
    assert.equal(plan.length, 3);
    assert.equal(plan[0][2], "apps/api/Dockerfile");
    assert.equal(plan[0][4], "atlas-api:local");
    assert.equal(plan[1][2], "apps/web/Dockerfile");
    assert.equal(plan[1][4], "atlas-web:local");
    assert.equal(plan[2][2], "infra/observability/alloy/Dockerfile");
    assert.equal(plan[2][4], "atlas-metrics-collector:local");
  });
});
