import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const workspaceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(workspaceDirectory, "../..");
const composeFile = resolve(workspaceDirectory, "compose.yaml");

async function reserveAvailablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate an E2E port.");
  }
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
  return address.port;
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryDirectory,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed${signal === null ? ` with exit code ${String(code)}` : ` from signal ${signal}`}.`,
        ),
      );
    });
  });
}

const [postgresPort, mailpitSmtpPort, mailpitHttpPort, apiPort, webPort] = await Promise.all([
  reserveAvailablePort(),
  reserveAvailablePort(),
  reserveAvailablePort(),
  reserveAvailablePort(),
  reserveAvailablePort(),
]);
const composeProject = `atlas-e2e-${String(process.pid)}`;
const databaseName = `atlas_e2e_${String(process.pid)}`;
const databaseUrl = `postgresql://atlas_e2e:atlas_e2e_only@127.0.0.1:${String(postgresPort)}/${databaseName}`;
const webOrigin = `http://127.0.0.1:${String(webPort)}`;
const apiOrigin = `http://127.0.0.1:${String(apiPort)}`;
const environment = {
  ...process.env,
  NODE_ENV: "test",
  ATLAS_ENV: "test",
  LOG_LEVEL: "warn",
  DATABASE_URL: databaseUrl,
  EXPECTED_SCHEMA_VERSION: "7",
  API_PORT: String(apiPort),
  WEB_ORIGIN: webOrigin,
  VITE_API_BASE_URL: apiOrigin,
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: String(mailpitSmtpPort),
  SMTP_SECURE: "false",
  SMTP_FROM: "Atlas E2E <no-reply@atlas.test>",
  ATLAS_E2E_DATABASE_NAME: databaseName,
  ATLAS_E2E_POSTGRES_PORT: String(postgresPort),
  ATLAS_E2E_MAILPIT_SMTP_PORT: String(mailpitSmtpPort),
  ATLAS_E2E_MAILPIT_HTTP_PORT: String(mailpitHttpPort),
  ATLAS_E2E_MAILPIT_ORIGIN: `http://127.0.0.1:${String(mailpitHttpPort)}`,
  ATLAS_E2E_API_ORIGIN: apiOrigin,
  ATLAS_E2E_WEB_ORIGIN: webOrigin,
  ATLAS_E2E_WEB_PORT: String(webPort),
};
const composeArguments = ["compose", "-p", composeProject, "-f", composeFile];

try {
  await run("docker", [...composeArguments, "up", "-d", "--wait"], { env: environment });
  await run("pnpm", ["--filter", "@atlas/api", "db:migrate"], { env: environment });
  await run("pnpm", ["--filter", "@atlas/web", "build"], { env: environment });
  await run("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], {
    cwd: workspaceDirectory,
    env: environment,
  });
} finally {
  await run("docker", [...composeArguments, "down", "--volumes", "--remove-orphans"], {
    env: environment,
  }).catch((error) => {
    process.stderr.write(`E2E infrastructure cleanup failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
