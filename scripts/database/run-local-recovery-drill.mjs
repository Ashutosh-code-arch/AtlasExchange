import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(scriptDirectory, "../..");
const composeFile = resolve(repositoryDirectory, "infra/compose.yaml");
const localDatabaseUser = "atlas";
const localDatabasePassword = "atlas_local_only";
const localSourceDatabase = "atlas";

export function createRecoveryDatabaseName(randomSuffix = randomBytes(8).toString("hex")) {
  const name = `atlas_recovery_drill_${randomSuffix}`;
  assertSafeRecoveryDatabaseName(name);
  return name;
}

export function assertSafeRecoveryDatabaseName(name) {
  if (!/^atlas_recovery_drill_[0-9a-f]{16}$/.test(name)) {
    throw new Error("Recovery drill database name is outside the disposable namespace");
  }
}

export function createLocalDatabaseUrl(databaseName, port = "5432") {
  assertSafeRecoveryDatabaseName(databaseName);
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65_535) {
    throw new Error("ATLAS_POSTGRES_PORT must be a valid TCP port");
  }

  const url = new URL("postgresql://127.0.0.1");
  url.username = localDatabaseUser;
  url.password = localDatabasePassword;
  url.port = port;
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function createRecoveryEvidence({
  archiveBytes,
  archiveSha256,
  completedAt,
  durationMilliseconds,
  postgresVersion,
  validation,
}) {
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes <= 0) {
    throw new Error("Recovery archive size must be a positive safe integer");
  }
  if (!/^[0-9a-f]{64}$/.test(archiveSha256)) {
    throw new Error("Recovery archive digest must be a SHA-256 value");
  }
  if (!Number.isSafeInteger(durationMilliseconds) || durationMilliseconds < 0) {
    throw new Error("Recovery drill duration must be a non-negative safe integer");
  }
  if (Number.isNaN(Date.parse(completedAt))) {
    throw new Error("Recovery drill completion timestamp is invalid");
  }
  if (
    typeof postgresVersion !== "string" ||
    !/^postgres \(PostgreSQL\) 18\./.test(postgresVersion)
  ) {
    throw new Error("Recovery drill did not use the PostgreSQL 18 client baseline");
  }
  if (validation?.passed !== true) {
    throw new Error("Recovery validation must pass before evidence can be emitted");
  }

  return Object.freeze({
    event: "database.recovery_drill.completed",
    completedAt,
    durationMilliseconds,
    source: {
      environment: "local",
      database: localSourceDatabase,
      postgresVersion,
    },
    backup: {
      format: "postgresql-custom",
      archiveBytes,
      archiveSha256,
      retained: false,
    },
    restore: {
      target: "isolated-ephemeral-database",
      validation,
    },
  });
}

function sanitizeOutput(output) {
  return output.replaceAll(/postgres(?:ql)?:\/\/[^\s"']+/giu, "[REDACTED_DATABASE_URL]").trim();
}

function processFailure(command, code, stderr) {
  const detail = sanitizeOutput(stderr);
  return new Error(
    `${command} failed with exit code ${String(code)}${detail.length > 0 ? `: ${detail}` : ""}`,
  );
}

function runBuffered(command, arguments_, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryDirectory,
      env: options.env ?? process.env,
      stdio: [options.inputPath === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolvePromise({ stdout: output, stderr: errors });
      else reject(processFailure(command, code, errors));
    });

    if (options.inputPath !== undefined) {
      createReadStream(options.inputPath).on("error", reject).pipe(child.stdin);
    }
  });
}

function runToFile(command, arguments_, outputPath) {
  return new Promise((resolvePromise, reject) => {
    const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
    const child = spawn(command, arguments_, {
      cwd: repositoryDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = [];
    let processCode;
    let outputFinished = false;

    const settle = () => {
      if (processCode === undefined || !outputFinished) return;
      if (processCode === 0) resolvePromise();
      else reject(processFailure(command, processCode, Buffer.concat(stderr).toString("utf8")));
    };

    child.stdout.pipe(output);
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    output.on("error", reject);
    output.on("finish", () => {
      outputFinished = true;
      settle();
    });
    child.on("close", (code) => {
      processCode = code;
      settle();
    });
  });
}

function composeExecArguments(command, ...arguments_) {
  return ["compose", "--file", composeFile, "exec", "--no-TTY", "postgres", command, ...arguments_];
}

function parseValidationOutput(output) {
  for (const line of output.trim().split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.event === "database.recovery_validation.completed") return parsed.report;
    } catch {
      // Package-manager status lines are not JSON and are intentionally ignored.
    }
  }
  throw new Error("Recovery validator did not emit a successful report");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function runLocalRecoveryDrill(environment = process.env) {
  const startedAt = Date.now();
  const databaseName = createRecoveryDatabaseName();
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "atlas-recovery-drill-"));
  const archivePath = resolve(temporaryDirectory, "atlas.dump");
  const databaseUrl = createLocalDatabaseUrl(
    databaseName,
    environment.ATLAS_POSTGRES_PORT ?? "5432",
  );
  let databaseCreated = false;

  try {
    await runBuffered(
      "docker",
      composeExecArguments(
        "pg_isready",
        "--username",
        localDatabaseUser,
        "--dbname",
        localSourceDatabase,
      ),
    );
    const version = await runBuffered("docker", composeExecArguments("postgres", "--version"));
    const postgresVersion = version.stdout.trim();

    await runToFile(
      "docker",
      composeExecArguments(
        "pg_dump",
        "--username",
        localDatabaseUser,
        "--dbname",
        localSourceDatabase,
        "--format",
        "custom",
        "--compress",
        "zstd:6",
        "--no-owner",
        "--no-privileges",
      ),
      archivePath,
    );
    await runBuffered("docker", composeExecArguments("pg_restore", "--list"), {
      inputPath: archivePath,
    });
    await runBuffered(
      "docker",
      composeExecArguments(
        "createdb",
        "--username",
        localDatabaseUser,
        "--template",
        "template0",
        databaseName,
      ),
    );
    databaseCreated = true;
    await runBuffered(
      "docker",
      composeExecArguments(
        "pg_restore",
        "--username",
        localDatabaseUser,
        "--dbname",
        databaseName,
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--no-privileges",
      ),
      { inputPath: archivePath },
    );

    const validationOutput = await runBuffered(
      "pnpm",
      ["--filter", "@atlas/api", "db:verify-recovery"],
      { env: { ...environment, DATABASE_URL: databaseUrl } },
    );
    const validation = parseValidationOutput(validationOutput.stdout);
    const archiveStatistics = await stat(archivePath);

    return createRecoveryEvidence({
      archiveBytes: archiveStatistics.size,
      archiveSha256: await sha256File(archivePath),
      completedAt: new Date().toISOString(),
      durationMilliseconds: Date.now() - startedAt,
      postgresVersion,
      validation,
    });
  } finally {
    try {
      if (databaseCreated) {
        assertSafeRecoveryDatabaseName(databaseName);
        await runBuffered(
          "docker",
          composeExecArguments(
            "dropdb",
            "--username",
            localDatabaseUser,
            "--if-exists",
            "--force",
            databaseName,
          ),
        );
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLocalRecoveryDrill()
    .then((evidence) => process.stdout.write(`${JSON.stringify(evidence)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({
          event: "database.recovery_drill.failed",
          message: error instanceof Error ? error.message : "Unknown recovery drill failure",
        })}\n`,
      );
      process.exitCode = 1;
    });
}
