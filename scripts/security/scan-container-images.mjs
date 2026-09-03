import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseImageSelection, selectContainerImages } from "../containers/build-images.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, "../..");
const exceptionManifestPath = resolve(
  repositoryDirectory,
  "security/vulnerability-exceptions.json",
);
const maximumExceptionDurationMilliseconds = 30 * 24 * 60 * 60 * 1000;

export const scannerImage =
  "anchore/grype:v0.116.1@sha256:1e71065c0a4cff3e6bd3b8add525ffac4343eb4971694eb90a31cf6d4d3e85db";

export const runtimeImages = Object.freeze(selectContainerImages().map((image) => image.tag));

function commonRuntimeArguments(user, cacheMount) {
  return [
    "run",
    "--rm",
    "--user",
    user,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,mode=1777,size=1g",
    "--volume",
    cacheMount,
    "--env",
    "HOME=/scanner",
  ];
}

export function createDatabaseUpdateArguments(cacheDirectory, user) {
  return [
    ...commonRuntimeArguments(user, `${cacheDirectory}:/scanner/.cache/grype`),
    "--env",
    "GRYPE_CHECK_FOR_APP_UPDATE=false",
    scannerImage,
    "db",
    "update",
  ];
}

export function createImageSaveArguments(image, archivePath) {
  return ["image", "save", "--output", archivePath, image];
}

export function createScanArguments(archivePath, cacheDirectory, user, configPath) {
  const configArguments =
    configPath === undefined ? [] : ["--volume", `${configPath}:/scan/grype.yaml:ro`];
  const scannerConfigArguments = configPath === undefined ? [] : ["--config", "/scan/grype.yaml"];

  return [
    ...commonRuntimeArguments(user, `${cacheDirectory}:/scanner/.cache/grype:ro`),
    "--network",
    "none",
    "--volume",
    `${archivePath}:/scan/image.tar:ro`,
    ...configArguments,
    "--env",
    "GRYPE_CHECK_FOR_APP_UPDATE=false",
    "--env",
    "GRYPE_DB_AUTO_UPDATE=false",
    "--env",
    "GRYPE_DB_VALIDATE_AGE=true",
    "--env",
    "GRYPE_DB_MAX_ALLOWED_BUILT_AGE=120h",
    scannerImage,
    ...scannerConfigArguments,
    "docker-archive:/scan/image.tar",
    "--fail-on",
    "high",
  ];
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function parseTimestamp(value, field) {
  const timestamp = requireNonEmptyString(value, field);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw new Error(`${field} must be an ISO timestamp`);
  return milliseconds;
}

export function validateVulnerabilityExceptions(input, now = new Date()) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("vulnerability exception manifest must be an object");
  }
  if (input.schemaVersion !== 1) {
    throw new Error("vulnerability exception manifest schemaVersion must be 1");
  }
  if (!Array.isArray(input.exceptions)) {
    throw new Error("vulnerability exception manifest exceptions must be an array");
  }

  const validated = [];
  const identities = new Set();
  for (const [index, candidate] of input.exceptions.entries()) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error(`exceptions[${index}] must be an object`);
    }
    const prefix = `exceptions[${index}]`;
    const advisory = requireNonEmptyString(candidate.advisory, `${prefix}.advisory`);
    const image = requireNonEmptyString(candidate.image, `${prefix}.image`);
    const package_ = candidate.package;
    if (typeof package_ !== "object" || package_ === null || Array.isArray(package_)) {
      throw new Error(`${prefix}.package must be an object`);
    }
    for (const field of ["name", "version", "type", "location"]) {
      requireNonEmptyString(package_[field], `${prefix}.package.${field}`);
    }
    for (const field of ["affectedPath", "rationale", "owner", "reviewSource"]) {
      requireNonEmptyString(candidate[field], `${prefix}.${field}`);
    }
    if (!candidate.reviewSource.startsWith("https://")) {
      throw new Error(`${prefix}.reviewSource must use HTTPS`);
    }
    if (
      !Array.isArray(candidate.compensatingControls) ||
      candidate.compensatingControls.length === 0
    ) {
      throw new Error(`${prefix}.compensatingControls must be a non-empty array`);
    }
    candidate.compensatingControls.forEach((control, controlIndex) =>
      requireNonEmptyString(control, `${prefix}.compensatingControls[${controlIndex}]`),
    );

    const approvedAt = parseTimestamp(candidate.approvedAt, `${prefix}.approvedAt`);
    const expiresAt = parseTimestamp(candidate.expiresAt, `${prefix}.expiresAt`);
    if (approvedAt > now.getTime()) throw new Error(`${prefix} approval is in the future`);
    if (expiresAt <= approvedAt) throw new Error(`${prefix} must expire after approval`);
    if (expiresAt - approvedAt > maximumExceptionDurationMilliseconds) {
      throw new Error(`${prefix} exceeds the thirty-day exception limit`);
    }
    if (expiresAt <= now.getTime()) throw new Error(`${prefix} has expired`);

    const identity = `${image}\u0000${advisory}\u0000${package_.name}\u0000${package_.version}`;
    if (identities.has(identity)) throw new Error(`${prefix} duplicates an existing exception`);
    identities.add(identity);
    validated.push(candidate);
  }

  return Object.freeze(validated);
}

export function renderGrypeExceptionConfig(exceptions) {
  if (exceptions.length === 0) return "ignore: []\n";
  const lines = ["ignore:"];
  for (const exception of exceptions) {
    lines.push(
      `  - vulnerability: ${JSON.stringify(exception.advisory)}`,
      "    package:",
      `      name: ${JSON.stringify(exception.package.name)}`,
      `      version: ${JSON.stringify(exception.package.version)}`,
      `      type: ${JSON.stringify(exception.package.type)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function loadVulnerabilityExceptions() {
  return validateVulnerabilityExceptions(JSON.parse(readFileSync(exceptionManifestPath, "utf8")));
}

function executeDocker(arguments_) {
  execFileSync("docker", arguments_, {
    cwd: repositoryDirectory,
    stdio: "inherit",
  });
}

export function scanContainerImages(application = "all") {
  const selectedImages = selectContainerImages(application).map((image) => image.tag);
  const vulnerabilityExceptions = loadVulnerabilityExceptions();
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "atlas-container-scan-"));
  const cacheDirectory = resolve(temporaryDirectory, "cache");
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  mkdirSync(cacheDirectory, { mode: 0o700 });
  chmodSync(cacheDirectory, 0o700);

  try {
    process.stdout.write("Updating the pinned vulnerability database...\n");
    executeDocker(createDatabaseUpdateArguments(cacheDirectory, user));

    for (const [index, image] of selectedImages.entries()) {
      const archivePath = resolve(temporaryDirectory, `image-${index}.tar`);
      const imageExceptions = vulnerabilityExceptions.filter(
        (exception) => exception.image === image,
      );
      const configPath =
        imageExceptions.length === 0
          ? undefined
          : resolve(temporaryDirectory, `grype-${index}.yaml`);
      if (configPath !== undefined) {
        writeFileSync(configPath, renderGrypeExceptionConfig(imageExceptions), { mode: 0o600 });
        const exceptionSummary = imageExceptions
          .map((exception) => `${exception.advisory} until ${exception.expiresAt}`)
          .join(", ");
        process.stdout.write(
          `Applying ${imageExceptions.length} reviewed exception to ${image}: ${exceptionSummary}\n`,
        );
      }
      process.stdout.write(`Saving ${image} to an isolated scan archive...\n`);
      executeDocker(createImageSaveArguments(image, archivePath));
      process.stdout.write(`Scanning ${image}; High or Critical findings fail the gate...\n`);
      executeDocker(createScanArguments(archivePath, cacheDirectory, user, configPath));
      rmSync(archivePath, { force: true });
    }
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    scanContainerImages(parseImageSelection(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `Atlas container vulnerability scan failed: ${
        error instanceof Error ? error.message : "unknown error"
      }\n`,
    );
    process.exitCode = 1;
  }
}
