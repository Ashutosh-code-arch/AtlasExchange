import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, "../..");
const rootManifest = JSON.parse(readFileSync(resolve(repositoryDirectory, "package.json"), "utf8"));

const images = Object.freeze([
  Object.freeze({ dockerfile: "apps/api/Dockerfile", tag: "atlas-api:local" }),
  Object.freeze({ dockerfile: "apps/web/Dockerfile", tag: "atlas-web:local" }),
  Object.freeze({
    dockerfile: "infra/observability/alloy/Dockerfile",
    tag: "atlas-metrics-collector:local",
  }),
]);

function gitValue(arguments_) {
  try {
    return execFileSync("git", arguments_, {
      cwd: repositoryDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function requireMetadata(name, value, predicate) {
  if (typeof value !== "string" || !predicate(value)) {
    throw new Error(`Invalid container build metadata: ${name}`);
  }
  return value;
}

export function resolveBuildMetadata(environment = process.env) {
  const packageVersion = requireMetadata("package version", rootManifest.version, (value) =>
    /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/.test(value),
  );
  const repositoryUrl =
    typeof rootManifest.repository === "object" && rootManifest.repository !== null
      ? rootManifest.repository.url
      : undefined;

  const dirtySuffix = gitValue(["status", "--porcelain"]) === "" ? "" : ".dirty";
  const version = requireMetadata(
    "ATLAS_IMAGE_VERSION",
    environment.ATLAS_IMAGE_VERSION ?? `${packageVersion}-local${dirtySuffix}`,
    (value) => /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/.test(value),
  );
  const revision = requireMetadata(
    "ATLAS_IMAGE_REVISION",
    environment.ATLAS_IMAGE_REVISION ?? gitValue(["rev-parse", "HEAD"]) ?? "unknown",
    (value) => value === "unknown" || /^[0-9a-f]{40}$/.test(value),
  );
  const created = requireMetadata(
    "ATLAS_IMAGE_CREATED",
    environment.ATLAS_IMAGE_CREATED ??
      gitValue(["show", "-s", "--format=%cI", "HEAD"]) ??
      "1970-01-01T00:00:00.000Z",
    (value) => !Number.isNaN(Date.parse(value)) && !/[\r\n]/.test(value),
  );
  const source = requireMetadata(
    "ATLAS_IMAGE_SOURCE",
    environment.ATLAS_IMAGE_SOURCE ?? repositoryUrl,
    (value) => {
      try {
        return new URL(value).protocol === "https:" && !/[\r\n]/.test(value);
      } catch {
        return false;
      }
    },
  );

  return Object.freeze({ created, revision, source, version });
}

export function createDockerBuildArguments(image, metadata) {
  return [
    "build",
    "--file",
    image.dockerfile,
    "--tag",
    image.tag,
    "--build-arg",
    `ATLAS_IMAGE_VERSION=${metadata.version}`,
    "--build-arg",
    `ATLAS_IMAGE_REVISION=${metadata.revision}`,
    "--build-arg",
    `ATLAS_IMAGE_CREATED=${metadata.created}`,
    "--build-arg",
    `ATLAS_IMAGE_SOURCE=${metadata.source}`,
    ".",
  ];
}

export function createContainerBuildPlan(metadata = resolveBuildMetadata()) {
  return images.map((image) => Object.freeze(createDockerBuildArguments(image, metadata)));
}

export function buildContainerImages(environment = process.env) {
  for (const arguments_ of createContainerBuildPlan(resolveBuildMetadata(environment))) {
    execFileSync("docker", arguments_, { cwd: repositoryDirectory, stdio: "inherit" });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildContainerImages();
  } catch (error) {
    process.stderr.write(
      `Atlas container build failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
