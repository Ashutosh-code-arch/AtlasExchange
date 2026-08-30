import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, "../..");

export const scannerImage =
  "anchore/grype:v0.116.1@sha256:1e71065c0a4cff3e6bd3b8add525ffac4343eb4971694eb90a31cf6d4d3e85db";

export const runtimeImages = Object.freeze(["atlas-api:local", "atlas-web:local"]);

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
    "/tmp:rw,noexec,nosuid,mode=1777,size=512m",
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

export function createScanArguments(archivePath, cacheDirectory, user) {
  return [
    ...commonRuntimeArguments(user, `${cacheDirectory}:/scanner/.cache/grype:ro`),
    "--network",
    "none",
    "--volume",
    `${archivePath}:/scan/image.tar:ro`,
    "--env",
    "GRYPE_CHECK_FOR_APP_UPDATE=false",
    "--env",
    "GRYPE_DB_AUTO_UPDATE=false",
    "--env",
    "GRYPE_DB_VALIDATE_AGE=true",
    "--env",
    "GRYPE_DB_MAX_ALLOWED_BUILT_AGE=120h",
    scannerImage,
    "docker-archive:/scan/image.tar",
    "--fail-on",
    "high",
  ];
}

function executeDocker(arguments_) {
  execFileSync("docker", arguments_, {
    cwd: repositoryDirectory,
    stdio: "inherit",
  });
}

export function scanContainerImages() {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "atlas-container-scan-"));
  const cacheDirectory = resolve(temporaryDirectory, "cache");
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  mkdirSync(cacheDirectory, { mode: 0o700 });
  chmodSync(cacheDirectory, 0o700);

  try {
    process.stdout.write("Updating the pinned vulnerability database...\n");
    executeDocker(createDatabaseUpdateArguments(cacheDirectory, user));

    for (const [index, image] of runtimeImages.entries()) {
      const archivePath = resolve(temporaryDirectory, `image-${index}.tar`);
      process.stdout.write(`Saving ${image} to an isolated scan archive...\n`);
      executeDocker(createImageSaveArguments(image, archivePath));
      process.stdout.write(`Scanning ${image}; High or Critical findings fail the gate...\n`);
      executeDocker(createScanArguments(archivePath, cacheDirectory, user));
      rmSync(archivePath, { force: true });
    }
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    scanContainerImages();
  } catch (error) {
    process.stderr.write(
      `Atlas container vulnerability scan failed: ${
        error instanceof Error ? error.message : "unknown error"
      }\n`,
    );
    process.exitCode = 1;
  }
}
