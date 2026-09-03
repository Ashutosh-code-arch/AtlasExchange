import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectContainerImages } from "../containers/build-images.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, "../..");

export function parseReleaseTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (match === null) throw new Error("Release tag must use stable vMAJOR.MINOR.PATCH syntax");
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function normalizeRegistryNamespace(owner) {
  const namespace = owner.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(namespace)) {
    throw new Error("GitHub repository owner cannot form a registry namespace");
  }
  return namespace;
}

export function validatePackageVersion(releaseVersion, packageVersion) {
  if (releaseVersion !== packageVersion) {
    throw new Error("Release tag and package version do not match");
  }
}

export function createReleaseMetadata({ created, owner, revision, tag }) {
  const version = parseReleaseTag(tag);
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Release revision is invalid");
  if (Number.isNaN(Date.parse(created)) || /[\r\n]/.test(created)) {
    throw new Error("Release creation timestamp is invalid");
  }
  return Object.freeze({
    created,
    registryNamespace: normalizeRegistryNamespace(owner),
    revision,
    version,
  });
}

export function createReleaseMatrix(application = "all") {
  return {
    include: selectContainerImages(application).map(({ dockerfile, tag }) => ({
      application: tag.slice("atlas-".length, -":local".length),
      image: tag.slice(0, -":local".length),
      dockerfile,
    })),
  };
}

export function serializeGitHubOutputs(metadata, application = "all") {
  return [
    `created=${metadata.created}`,
    `registry_namespace=${metadata.registryNamespace}`,
    `revision=${metadata.revision}`,
    `version=${metadata.version}`,
    `matrix=${JSON.stringify(createReleaseMatrix(application))}`,
    "",
  ].join("\n");
}

function git(arguments_) {
  return execFileSync("git", arguments_, {
    cwd: repositoryDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

export function prepareRelease(environment = process.env) {
  const tag = environment.ATLAS_RELEASE_TAG;
  const owner = environment.GITHUB_REPOSITORY_OWNER;
  const outputPath = environment.GITHUB_OUTPUT;
  if (tag === undefined || owner === undefined || outputPath === undefined) {
    throw new Error("Release workflow environment is incomplete");
  }

  parseReleaseTag(tag);
  createReleaseMatrix(environment.ATLAS_RELEASE_APPLICATION);

  const revision = git(["rev-list", "-n", "1", tag]);
  if (git(["rev-parse", "HEAD"]) !== revision) {
    throw new Error("Checked-out source does not match the release tag");
  }
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", revision, "origin/main"], {
    cwd: repositoryDirectory,
    stdio: "inherit",
  });
  if (ancestry.status !== 0) throw new Error("Release revision is not reachable from origin/main");

  const metadata = createReleaseMetadata({
    created: git(["show", "-s", "--format=%cI", revision]),
    owner,
    revision,
    tag,
  });
  const manifest = JSON.parse(readFileSync(resolve(repositoryDirectory, "package.json"), "utf8"));
  validatePackageVersion(metadata.version, manifest.version);
  appendFileSync(
    outputPath,
    serializeGitHubOutputs(metadata, environment.ATLAS_RELEASE_APPLICATION),
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({ event: "release.validated", revision, version: metadata.version })}\n`,
  );
  return metadata;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    prepareRelease();
  } catch (error) {
    process.stderr.write(
      `Atlas release validation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
