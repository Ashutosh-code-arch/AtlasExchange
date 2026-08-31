import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import {
  Argon2PasswordHasher,
  DemoIdentityProvisioningConflictError,
  LocalCompromisedPasswordChecker,
  PostgresDemoIdentityProvisioningTransactionRunner,
  ProvisionDemoIdentity,
  type IdentityDatabaseSchema,
} from "../src/modules/identity/index.js";
import { createDatabaseResources, type DatabaseSchema } from "../src/platform/database/database.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const integerString = z.string().regex(/^\d+$/u);
const provisioningEnvironmentSchema = z.object({
  ATLAS_ENV: z.literal("demo"),
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  EXPECTED_SCHEMA_VERSION: integerString.default("15"),
  PASSWORD_BLOCKLIST_PATH: z.string().min(1),
  DEMO_IDENTITY_EMAIL: z.string().min(1),
  DEMO_IDENTITY_PASSWORD: z.string().min(1),
});

export interface DemoIdentityProvisioningConfig {
  readonly databaseUrl: string;
  readonly expectedSchemaVersion: string;
  readonly passwordBlocklistPath: string;
  readonly email: string;
  readonly password: string;
}

export class DemoIdentityProvisioningConfigurationError extends Error {
  public constructor(variableNames: readonly string[]) {
    super(`Invalid demo identity provisioning configuration: ${variableNames.join(", ")}`);
    this.name = "DemoIdentityProvisioningConfigurationError";
  }
}

export function parseDemoIdentityProvisioningConfig(
  environment: NodeJS.ProcessEnv,
): DemoIdentityProvisioningConfig {
  const result = provisioningEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const variables = [
      ...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "environment"))),
    ];
    throw new DemoIdentityProvisioningConfigurationError(variables);
  }
  return Object.freeze({
    databaseUrl: result.data.DATABASE_URL,
    expectedSchemaVersion: result.data.EXPECTED_SCHEMA_VERSION,
    passwordBlocklistPath: result.data.PASSWORD_BLOCKLIST_PATH,
    email: result.data.DEMO_IDENTITY_EMAIL,
    password: result.data.DEMO_IDENTITY_PASSWORD,
  });
}

async function loadRestrictedEnvironmentFile(environment: NodeJS.ProcessEnv): Promise<void> {
  const sourcePath = environment.ATLAS_DEMO_BOOTSTRAP_ENV_FILE;
  if (sourcePath === undefined || !isAbsolute(sourcePath)) {
    throw new DemoIdentityProvisioningConfigurationError(["ATLAS_DEMO_BOOTSTRAP_ENV_FILE"]);
  }
  const resolvedPath = resolve(sourcePath);
  const repositoryRelativePath = relative(repositoryRoot, resolvedPath);
  if (
    repositoryRelativePath === "" ||
    (!repositoryRelativePath.startsWith("..") && !isAbsolute(repositoryRelativePath))
  ) {
    throw new DemoIdentityProvisioningConfigurationError(["ATLAS_DEMO_BOOTSTRAP_ENV_FILE"]);
  }
  const file = await stat(resolvedPath);
  if (!file.isFile() || (file.mode & 0o077) !== 0) {
    throw new DemoIdentityProvisioningConfigurationError(["ATLAS_DEMO_BOOTSTRAP_ENV_FILE"]);
  }
  process.loadEnvFile(resolvedPath);
}

export async function runDemoIdentityProvisioning(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<"created" | "existing"> {
  const config = parseDemoIdentityProvisioningConfig(environment);
  const database = createDatabaseResources<DatabaseSchema & IdentityDatabaseSchema>(
    config.databaseUrl,
    config.expectedSchemaVersion,
    {
      pool: {
        maximumConnections: 1,
        connectionTimeoutMs: 5_000,
        idleTimeoutMs: 10_000,
        maximumLifetimeSeconds: 120,
        statementTimeoutMs: 15_000,
        lockTimeoutMs: 5_000,
        idleTransactionTimeoutMs: 30_000,
        readinessTimeoutMs: 2_000,
      },
    },
  );

  try {
    if (!(await database.checkReadiness())) {
      throw new Error("Demo database is not ready at the expected schema version.");
    }
    const compromisedPasswordChecker = await LocalCompromisedPasswordChecker.fromFile(
      config.passwordBlocklistPath,
    );
    const result = await new ProvisionDemoIdentity({
      compromisedPasswordChecker,
      passwordHasher: new Argon2PasswordHasher(),
      transactionRunner: new PostgresDemoIdentityProvisioningTransactionRunner(database.database),
    }).execute({ email: config.email, password: config.password });
    return result.status;
  } finally {
    await database.close();
  }
}

async function main(): Promise<void> {
  try {
    await loadRestrictedEnvironmentFile(process.env);
    const status = await runDemoIdentityProvisioning(process.env);
    process.stdout.write(
      `${JSON.stringify({ event: "identity.demo_identity.provisioned", status })}\n`,
    );
  } catch (error) {
    const reason =
      error instanceof DemoIdentityProvisioningConfigurationError ||
      error instanceof DemoIdentityProvisioningConflictError
        ? error.message
        : error instanceof Error
          ? error.name
          : "UnknownError";
    process.stderr.write(
      `${JSON.stringify({ event: "identity.demo_identity.provisioning_failed", reason })}\n`,
    );
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entryPath === fileURLToPath(import.meta.url)) {
  await main();
}
