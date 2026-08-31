import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const revisionPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const audiencePattern = /^[A-Za-z0-9_-]{32,128}$/;
const resourceNamePattern = /^[a-z][a-z0-9-]{0,62}$/;

function requireObject(value, field) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requireExactKeys(value, field, expectedKeys) {
  const object = requireObject(value, field);
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} must contain exactly: ${expected.join(", ")}`);
  }
  return object;
}

function requireString(value, field, pattern) {
  if (typeof value !== "string" || value.trim() !== value || value === "") {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  if (pattern !== undefined && !pattern.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function exactHttpsOrigin(value, field, suffix) {
  const raw = requireString(value, field);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${field} must be an HTTPS origin`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.hostname.endsWith(suffix) ||
    url.hostname === suffix.slice(1)
  ) {
    throw new Error(`${field} must be an exact provider HTTPS origin`);
  }
  return url.origin;
}

function validateRelease(value) {
  const release = requireExactKeys(value, "release", ["apiImageDigest", "revision", "version"]);
  return Object.freeze({
    apiImageDigest: requireString(release.apiImageDigest, "release.apiImageDigest", digestPattern),
    revision: requireString(release.revision, "release.revision", revisionPattern),
    version: requireString(release.version, "release.version", stableVersionPattern),
  });
}

function validateCloudflare(value, revision) {
  const cloudflare = requireExactKeys(value, "cloudflare", [
    "accessApplicationTarget",
    "accessAudience",
    "accessTeamDomain",
    "customDomains",
    "exactEmailAllowPolicy",
    "paidOverage",
    "plan",
    "previewUrls",
    "publicOrigin",
    "workerName",
    "workerSourceRevision",
  ]);
  if (
    cloudflare.plan !== "free" ||
    cloudflare.paidOverage !== false ||
    cloudflare.customDomains !== false ||
    cloudflare.previewUrls !== false ||
    cloudflare.accessApplicationTarget !== "worker-name" ||
    cloudflare.exactEmailAllowPolicy !== true
  ) {
    throw new Error("cloudflare must preserve the zero-cost private Worker boundary");
  }
  const workerName = requireString(
    cloudflare.workerName,
    "cloudflare.workerName",
    resourceNamePattern,
  );
  const publicOrigin = exactHttpsOrigin(
    cloudflare.publicOrigin,
    "cloudflare.publicOrigin",
    ".workers.dev",
  );
  if (!new URL(publicOrigin).hostname.startsWith(`${workerName}.`)) {
    throw new Error("cloudflare.publicOrigin must belong to cloudflare.workerName");
  }
  const workerSourceRevision = requireString(
    cloudflare.workerSourceRevision,
    "cloudflare.workerSourceRevision",
    revisionPattern,
  );
  if (workerSourceRevision !== revision) {
    throw new Error("cloudflare.workerSourceRevision must equal release.revision");
  }
  return Object.freeze({
    accessAudience: requireString(
      cloudflare.accessAudience,
      "cloudflare.accessAudience",
      audiencePattern,
    ),
    accessTeamDomain: exactHttpsOrigin(
      cloudflare.accessTeamDomain,
      "cloudflare.accessTeamDomain",
      ".cloudflareaccess.com",
    ),
    publicOrigin,
    workerName,
    workerSourceRevision,
  });
}

function validateRender(value) {
  const render = requireExactKeys(value, "render", [
    "apiOrigin",
    "instances",
    "paidFeatures",
    "plan",
    "region",
    "serviceName",
  ]);
  if (render.plan !== "free" || render.instances !== 1 || render.paidFeatures !== false) {
    throw new Error("render must use one instance with no paid feature");
  }
  const serviceName = requireString(render.serviceName, "render.serviceName", resourceNamePattern);
  const apiOrigin = exactHttpsOrigin(render.apiOrigin, "render.apiOrigin", ".onrender.com");
  if (new URL(apiOrigin).hostname !== `${serviceName}.onrender.com`) {
    throw new Error("render.apiOrigin must belong to render.serviceName");
  }
  return Object.freeze({
    apiOrigin,
    region: requireString(render.region, "render.region", resourceNamePattern),
    serviceName,
  });
}

function validateNeon(value) {
  const neon = requireExactKeys(value, "neon", [
    "paidFeatures",
    "plan",
    "postgresMajorVersion",
    "schemaVersion",
  ]);
  if (
    neon.plan !== "free" ||
    neon.paidFeatures !== false ||
    neon.postgresMajorVersion !== 18 ||
    neon.schemaVersion !== 15
  ) {
    throw new Error("neon must use free PostgreSQL 18 at Atlas schema version 15");
  }
  return Object.freeze({ postgresMajorVersion: 18, schemaVersion: 15 });
}

function validateCost(value) {
  const cost = requireExactKeys(value, "cost", [
    "currency",
    "maximumMonthlyCostCents",
    "paymentMethodRequired",
  ]);
  if (
    cost.currency !== "USD" ||
    cost.maximumMonthlyCostCents !== 0 ||
    cost.paymentMethodRequired !== false
  ) {
    throw new Error("cost must enforce a zero-dollar ceiling without a required payment method");
  }
}

export function validateDemoDeploymentInput(input) {
  const config = requireExactKeys(input, "demo deployment input", [
    "cloudflare",
    "cost",
    "environment",
    "neon",
    "release",
    "render",
    "schemaVersion",
  ]);
  if (config.schemaVersion !== 1) throw new Error("schemaVersion must equal 1");
  if (config.environment !== "demo") throw new Error("environment must equal demo");
  const release = validateRelease(config.release);
  const cloudflare = validateCloudflare(config.cloudflare, release.revision);
  const render = validateRender(config.render);
  const neon = validateNeon(config.neon);
  validateCost(config.cost);
  if (cloudflare.publicOrigin === render.apiOrigin) {
    throw new Error("public and API origins must remain distinct");
  }
  return Object.freeze({ cloudflare, neon, release, render });
}

export function createDemoDeploymentManifest(configuration) {
  return Object.freeze({
    schemaVersion: 1,
    environment: "demo",
    recurringCost: Object.freeze({ currency: "USD", maximumMonthlyCostCents: 0 }),
    release: Object.freeze({
      version: configuration.release.version,
      revision: configuration.release.revision,
      apiImage: `ghcr.io/ashutosh-code-arch/atlas-api@${configuration.release.apiImageDigest}`,
      workerSourceRevision: configuration.cloudflare.workerSourceRevision,
    }),
    cloudflare: Object.freeze({
      workerName: configuration.cloudflare.workerName,
      publicOrigin: configuration.cloudflare.publicOrigin,
      plan: "free",
      workersDev: true,
      previewUrls: false,
      customDomains: false,
      access: Object.freeze({
        applicationTarget: "worker-name",
        exactEmailAllowPolicy: true,
        teamDomain: configuration.cloudflare.accessTeamDomain,
        audience: configuration.cloudflare.accessAudience,
      }),
      bindings: Object.freeze({
        ATLAS_ENV: "demo",
        ATLAS_API_ORIGIN: configuration.render.apiOrigin,
        ATLAS_PUBLIC_ORIGIN: configuration.cloudflare.publicOrigin,
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: configuration.cloudflare.accessTeamDomain,
        CLOUDFLARE_ACCESS_AUDIENCE: configuration.cloudflare.accessAudience,
        PUBLIC_REGISTRATION_ENABLED: "false",
        PUBLIC_PASSWORD_RECOVERY_ENABLED: "false",
      }),
    }),
    render: Object.freeze({
      serviceName: configuration.render.serviceName,
      apiOrigin: configuration.render.apiOrigin,
      plan: "free",
      region: configuration.render.region,
      instances: 1,
      image: `ghcr.io/ashutosh-code-arch/atlas-api@${configuration.release.apiImageDigest}`,
      healthCheckPath: "/health/ready",
      publicEnvironment: Object.freeze({
        NODE_ENV: "production",
        ATLAS_ENV: "demo",
        ATLAS_APPLICATION_VERSION: configuration.release.version,
        WEB_ORIGIN: configuration.cloudflare.publicOrigin,
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: configuration.cloudflare.accessTeamDomain,
        CLOUDFLARE_ACCESS_AUDIENCE: configuration.cloudflare.accessAudience,
        HTTP_TRUST_PROXY_HOPS: "1",
        EXPECTED_SCHEMA_VERSION: String(configuration.neon.schemaVersion),
        DATABASE_POOL_MAX_CONNECTIONS: "5",
        LOG_LEVEL: "info",
        METRICS_ENABLED: "true",
        REFERENCE_MARKET_DATA_ENABLED: "true",
        SIMULATED_FUNDING_ENABLED: "true",
        SIMULATED_WITHDRAWALS_ENABLED: "true",
        PASSWORD_BLOCKLIST_PATH: "/etc/secrets/atlas-password-blocklist.sha256",
      }),
      requiredSecretMaterial: Object.freeze([
        "DATABASE_URL",
        "CSRF_HMAC_KEY",
        "METRICS_BEARER_TOKEN",
        "atlas-password-blocklist.sha256",
      ]),
    }),
    neon: Object.freeze({
      plan: "free",
      postgresMajorVersion: configuration.neon.postgresMajorVersion,
      schemaVersion: configuration.neon.schemaVersion,
      connectionStringStorage: "Render secret DATABASE_URL only",
    }),
    stopConditions: Object.freeze([
      "provider requests payment or enables paid overage",
      "Cloudflare Access is not bound to the exact Worker name",
      "direct Render application traffic succeeds without a valid Access assertion",
      "provider origin, audience, digest, or source revision differs from this manifest",
    ]),
  });
}

export function serializeDemoDeploymentManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function parseArguments(arguments_) {
  if (arguments_.length !== 4 || arguments_[0] !== "--config" || arguments_[2] !== "--output") {
    throw new Error(
      "Usage: demo:deployment:generate --config <input.json> --output <manifest.json>",
    );
  }
  return Object.freeze({
    configPath: resolve(arguments_[1]),
    outputPath: resolve(arguments_[3]),
  });
}

export async function generateDemoDeployment(arguments_) {
  const paths = parseArguments(arguments_);
  let input;
  try {
    input = JSON.parse(await readFile(paths.configPath, "utf8"));
  } catch (error) {
    throw new Error("demo deployment input could not be read as JSON", { cause: error });
  }
  const configuration = validateDemoDeploymentInput(input);
  const manifest = createDemoDeploymentManifest(configuration);
  await writeFile(paths.outputPath, serializeDemoDeploymentManifest(manifest), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return manifest;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  generateDemoDeployment(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Demo deployment generation failed"}\n`,
    );
    process.exitCode = 1;
  });
}
