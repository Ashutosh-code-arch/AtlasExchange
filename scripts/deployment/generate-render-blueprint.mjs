import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateReadinessRecord } from "../operations/validate-readiness-record.mjs";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;
const maximumCostApprovalAgeMilliseconds = 30 * millisecondsPerDay;
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const registryCredentialPattern = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const reservedDomainSuffixes = [".example", ".invalid", ".localhost", ".test"];
const reservedPublicDomains = ["example.com", "example.net", "example.org"];
const requiredReadinessControls = Object.freeze([
  "runtime-database-selection",
  "candidate-vulnerability-scan",
  "release-provenance",
]);

const resourcePlans = Object.freeze({
  api: "1c-2g",
  web: "0.5c-512mb",
  collector: "0.5c-512mb",
  database: "0.5c-1g",
});

function requireObject(value, field) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requireExactKeys(value, field, expectedKeys) {
  const object = requireObject(value, field);
  const actualKeys = Object.keys(object).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(`${field} must contain exactly: ${sortedExpectedKeys.join(", ")}`);
  }
  return object;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() !== value || value === "") {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function parseTimestamp(value, field) {
  const timestamp = requireString(value, field);
  const milliseconds = Date.parse(timestamp);
  if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new Error(`${field} must be a canonical ISO-8601 UTC timestamp`);
  }
  return milliseconds;
}

function validateHostname(value, field) {
  const hostname = requireString(value, field);
  if (hostname !== hostname.toLowerCase() || !hostnamePattern.test(hostname)) {
    throw new Error(`${field} must be a lowercase fully qualified hostname`);
  }
  if (
    reservedDomainSuffixes.some(
      (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
    ) ||
    reservedPublicDomains.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    ) ||
    hostname.endsWith(".onrender.com") ||
    hostname.endsWith(".cloudflareaccess.com")
  ) {
    throw new Error(`${field} must be an Atlas-owned public hostname`);
  }
  return hostname;
}

function validateHttpsUrl(value, field, hostnameRequirement) {
  const raw = requireString(value, field);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${field} must be an HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (hostnameRequirement !== undefined && !hostnameRequirement(url.hostname))
  ) {
    throw new Error(`${field} must be a credential-free HTTPS URL`);
  }
  return url;
}

function validateCostApproval(value, now) {
  const approval = requireExactKeys(value, "costApproval", [
    "approvedAt",
    "approvedBy",
    "currency",
    "expiresAt",
    "maximumMonthlyCostCents",
  ]);
  if (approval.currency !== "USD") throw new Error("costApproval.currency must be USD");
  if (
    !Number.isSafeInteger(approval.maximumMonthlyCostCents) ||
    approval.maximumMonthlyCostCents <= 0
  ) {
    throw new Error("costApproval.maximumMonthlyCostCents must be a positive integer");
  }
  requireString(approval.approvedBy, "costApproval.approvedBy");
  const approvedAt = parseTimestamp(approval.approvedAt, "costApproval.approvedAt");
  const expiresAt = parseTimestamp(approval.expiresAt, "costApproval.expiresAt");
  if (approvedAt > now.getTime())
    throw new Error("costApproval.approvedAt cannot be in the future");
  if (expiresAt <= now.getTime()) throw new Error("costApproval has expired");
  if (expiresAt <= approvedAt) throw new Error("costApproval must expire after approval");
  if (expiresAt - approvedAt > maximumCostApprovalAgeMilliseconds) {
    throw new Error("costApproval cannot remain valid for more than thirty days");
  }
  return approval;
}

function validateRegistry(value) {
  const registry = requireObject(value, "registry");
  if (registry.visibility === "public") {
    requireExactKeys(registry, "registry", ["visibility"]);
    if (registry.credentialName !== undefined) {
      throw new Error("public registry configuration cannot name a credential");
    }
    return Object.freeze({ visibility: "public" });
  }
  if (registry.visibility !== "private") {
    throw new Error("registry.visibility must be public or private");
  }
  requireExactKeys(registry, "registry", ["credentialName", "visibility"]);
  const credentialName = requireString(registry.credentialName, "registry.credentialName");
  if (!registryCredentialPattern.test(credentialName)) {
    throw new Error("registry.credentialName is invalid");
  }
  return Object.freeze({ credentialName, visibility: "private" });
}

function validateSmtp(value) {
  const smtp = requireExactKeys(value, "smtp", [
    "authentication",
    "from",
    "host",
    "port",
    "secure",
  ]);
  const host = validateHostname(smtp.host, "smtp.host");
  if (!Number.isSafeInteger(smtp.port) || smtp.port < 1 || smtp.port > 65_535) {
    throw new Error("smtp.port must be a valid TCP port");
  }
  if (typeof smtp.secure !== "boolean") throw new Error("smtp.secure must be boolean");
  if (smtp.authentication !== "required" && smtp.authentication !== "none") {
    throw new Error("smtp.authentication must be required or none");
  }
  const from = requireString(smtp.from, "smtp.from");
  if (/[\r\n]/.test(from) || !/^[^<>\r\n]+ <[^@\s<>]+@[^@\s<>]+>$/.test(from)) {
    throw new Error("smtp.from must be a display name and email address");
  }
  return Object.freeze({
    authentication: smtp.authentication,
    from,
    host,
    port: smtp.port,
    secure: smtp.secure,
  });
}

function validateDeploymentReadiness(record, now) {
  const validated = validateReadinessRecord(record);
  if (validated.environment !== "staging") {
    throw new Error("deployment readiness record must target staging");
  }
  const controls = new Map(record.controls.map((control) => [control.id, control]));
  for (const id of requiredReadinessControls) {
    const control = controls.get(id);
    if (control?.status !== "passed") {
      throw new Error(`${id} must pass before Blueprint generation`);
    }
    if (Date.parse(control.expiresAt) <= now.getTime()) {
      throw new Error(`${id} evidence is expired at Blueprint generation time`);
    }
  }
  return Object.freeze({
    apiImageDigest: record.release.apiImageDigest,
    metricsCollectorImageDigest: record.release.metricsCollectorImageDigest,
    revision: validated.releaseRevision,
    version: validated.releaseVersion,
    webImageDigest: record.release.webImageDigest,
  });
}

export function validateStagingDeploymentInput(input, readinessRecord, now = new Date()) {
  const config = requireExactKeys(input, "staging deployment input", [
    "cloudflareAccess",
    "costApproval",
    "domain",
    "grafanaCloud",
    "registry",
    "schemaVersion",
    "smtp",
  ]);
  if (config.schemaVersion !== 1) throw new Error("schemaVersion must equal 1");

  const domain = requireExactKeys(config.domain, "domain", [
    "apiHostname",
    "registrableDomain",
    "webHostname",
  ]);
  const registrableDomain = validateHostname(domain.registrableDomain, "domain.registrableDomain");
  const webHostname = validateHostname(domain.webHostname, "domain.webHostname");
  const apiHostname = validateHostname(domain.apiHostname, "domain.apiHostname");
  if (
    webHostname === apiHostname ||
    !webHostname.endsWith(`.${registrableDomain}`) ||
    !apiHostname.endsWith(`.${registrableDomain}`)
  ) {
    throw new Error("web and API hostnames must be distinct children of registrableDomain");
  }

  const cloudflare = requireExactKeys(config.cloudflareAccess, "cloudflareAccess", [
    "audience",
    "teamDomain",
  ]);
  const teamDomain = validateHttpsUrl(
    cloudflare.teamDomain,
    "cloudflareAccess.teamDomain",
    (hostname) => hostname.endsWith(".cloudflareaccess.com") && hostname !== "cloudflareaccess.com",
  ).origin;
  const audience = requireString(cloudflare.audience, "cloudflareAccess.audience");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(audience)) {
    throw new Error("cloudflareAccess.audience is invalid");
  }

  const grafana = requireExactKeys(config.grafanaCloud, "grafanaCloud", [
    "prometheusUrl",
    "prometheusUsername",
  ]);
  const prometheusUrl = validateHttpsUrl(
    grafana.prometheusUrl,
    "grafanaCloud.prometheusUrl",
  ).href.replace(/\/$/, "");
  if (new URL(prometheusUrl).pathname === "/") {
    throw new Error("grafanaCloud.prometheusUrl must include the remote-write path");
  }
  const prometheusUsername = requireString(
    grafana.prometheusUsername,
    "grafanaCloud.prometheusUsername",
  );
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(prometheusUsername)) {
    throw new Error("grafanaCloud.prometheusUsername is invalid");
  }

  const release = validateDeploymentReadiness(readinessRecord, now);
  return Object.freeze({
    apiHostname,
    audience,
    costApproval: validateCostApproval(config.costApproval, now),
    grafanaCloud: Object.freeze({ prometheusUrl, prometheusUsername }),
    registry: validateRegistry(config.registry),
    registrableDomain,
    release,
    smtp: validateSmtp(config.smtp),
    teamDomain,
    webHostname,
  });
}

function image(url, registry) {
  return registry.visibility === "public"
    ? Object.freeze({ url })
    : Object.freeze({
        url,
        creds: Object.freeze({
          fromRegistryCreds: Object.freeze({ name: registry.credentialName }),
        }),
      });
}

function valueEnvironmentVariable(key, value) {
  return Object.freeze({ key, value: String(value) });
}

function createApiService(configuration) {
  const release = configuration.release;
  const service = {
    type: "web",
    name: "atlas-api-staging",
    runtime: "image",
    plan: resourcePlans.api,
    region: "singapore",
    numInstances: 1,
    image: image(
      `ghcr.io/ashutosh-code-arch/atlas-api@${release.apiImageDigest}`,
      configuration.registry,
    ),
    healthCheckPath: "/health/ready",
    preDeployCommand: "node --enable-source-maps dist/platform/database/migrate.js",
    maxShutdownDelaySeconds: 30,
    domains: [configuration.apiHostname],
    renderSubdomainPolicy: "disabled",
    envVars: [
      {
        key: "DATABASE_URL",
        fromDatabase: { name: "atlas-postgres-staging", property: "connectionString" },
      },
      valueEnvironmentVariable("NODE_ENV", "production"),
      valueEnvironmentVariable("ATLAS_ENV", "staging"),
      valueEnvironmentVariable("ATLAS_APPLICATION_VERSION", release.version),
      valueEnvironmentVariable("WEB_ORIGIN", `https://${configuration.webHostname}`),
      valueEnvironmentVariable("CLOUDFLARE_ACCESS_TEAM_DOMAIN", configuration.teamDomain),
      valueEnvironmentVariable("CLOUDFLARE_ACCESS_AUDIENCE", configuration.audience),
      valueEnvironmentVariable("HTTP_TRUST_PROXY_HOPS", 1),
      valueEnvironmentVariable("DATABASE_POOL_MAX_CONNECTIONS", 10),
      valueEnvironmentVariable("EXPECTED_SCHEMA_VERSION", 15),
      valueEnvironmentVariable("LOG_LEVEL", "info"),
      valueEnvironmentVariable("METRICS_ENABLED", true),
      { key: "METRICS_BEARER_TOKEN", generateValue: true },
      valueEnvironmentVariable(
        "PASSWORD_BLOCKLIST_PATH",
        "/etc/secrets/atlas-password-blocklist.sha256",
      ),
      valueEnvironmentVariable("SIMULATED_FUNDING_ENABLED", false),
      valueEnvironmentVariable("SIMULATED_WITHDRAWALS_ENABLED", false),
      valueEnvironmentVariable("SMTP_HOST", configuration.smtp.host),
      valueEnvironmentVariable("SMTP_PORT", configuration.smtp.port),
      valueEnvironmentVariable("SMTP_SECURE", configuration.smtp.secure),
      valueEnvironmentVariable("SMTP_FROM", configuration.smtp.from),
      { key: "CSRF_HMAC_KEY", sync: false },
    ],
  };
  if (configuration.smtp.authentication === "required") {
    service.envVars.push(
      { key: "SMTP_USERNAME", sync: false },
      { key: "SMTP_PASSWORD", sync: false },
    );
  }
  return service;
}

function createWebService(configuration) {
  return {
    type: "web",
    name: "atlas-web-staging",
    runtime: "image",
    plan: resourcePlans.web,
    region: "singapore",
    numInstances: 1,
    image: image(
      `ghcr.io/ashutosh-code-arch/atlas-web@${configuration.release.webImageDigest}`,
      configuration.registry,
    ),
    healthCheckPath: "/health/live",
    maxShutdownDelaySeconds: 30,
    domains: [configuration.webHostname],
    renderSubdomainPolicy: "disabled",
    envVars: [
      valueEnvironmentVariable("NODE_ENV", "production"),
      valueEnvironmentVariable("ATLAS_ENV", "staging"),
      valueEnvironmentVariable("ATLAS_WEB_API_BASE_URL", `https://${configuration.apiHostname}`),
      valueEnvironmentVariable("CLOUDFLARE_ACCESS_TEAM_DOMAIN", configuration.teamDomain),
      valueEnvironmentVariable("CLOUDFLARE_ACCESS_AUDIENCE", configuration.audience),
    ],
  };
}

function createCollectorService(configuration) {
  return {
    type: "pserv",
    name: "atlas-metrics-collector-staging",
    runtime: "image",
    plan: resourcePlans.collector,
    region: "singapore",
    numInstances: 1,
    image: image(
      `ghcr.io/ashutosh-code-arch/atlas-metrics-collector@${configuration.release.metricsCollectorImageDigest}`,
      configuration.registry,
    ),
    maxShutdownDelaySeconds: 30,
    envVars: [
      {
        key: "ATLAS_METRICS_TARGET",
        fromService: { name: "atlas-api-staging", type: "web", property: "hostport" },
      },
      {
        key: "METRICS_BEARER_TOKEN",
        fromService: {
          name: "atlas-api-staging",
          type: "web",
          envVarKey: "METRICS_BEARER_TOKEN",
        },
      },
      valueEnvironmentVariable(
        "GRAFANA_CLOUD_PROMETHEUS_URL",
        configuration.grafanaCloud.prometheusUrl,
      ),
      valueEnvironmentVariable(
        "GRAFANA_CLOUD_PROMETHEUS_USERNAME",
        configuration.grafanaCloud.prometheusUsername,
      ),
      { key: "GRAFANA_CLOUD_METRICS_TOKEN", sync: false },
    ],
  };
}

function createDatabase() {
  return {
    name: "atlas-postgres-staging",
    plan: resourcePlans.database,
    region: "singapore",
    postgresMajorVersion: "18",
    databaseName: "atlas",
    user: "atlas",
    diskSizeGB: 15,
    storageAutoscalingEnabled: false,
    ipAllowList: [],
    connectionPool: "none",
  };
}

export function createRenderBlueprint(configuration) {
  return Object.freeze({
    previews: Object.freeze({ generation: "off" }),
    projects: [
      {
        name: "atlas-exchange",
        environments: [
          {
            name: "staging",
            networking: { isolation: "enabled" },
            permissions: { protection: "enabled" },
            services: [
              createApiService(configuration),
              createWebService(configuration),
              createCollectorService(configuration),
            ],
            databases: [createDatabase()],
          },
        ],
      },
    ],
  });
}

function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function scalar(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}

function yamlLines(value, indentation) {
  const prefix = " ".repeat(indentation);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}[]`];
    return value.flatMap((item) =>
      isScalar(item)
        ? [`${prefix}- ${scalar(item)}`]
        : [`${prefix}-`, ...yamlLines(item, indentation + 2)],
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return [`${prefix}{}`];
  return entries.flatMap(([key, item]) => {
    if (isScalar(item)) return [`${prefix}${key}: ${scalar(item)}`];
    if (Array.isArray(item) && item.length === 0) return [`${prefix}${key}: []`];
    return [`${prefix}${key}:`, ...yamlLines(item, indentation + 2)];
  });
}

export function serializeRenderBlueprint(blueprint) {
  return `${yamlLines(blueprint, 0).join("\n")}\n`;
}

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!new Set(["--config", "--readiness", "--output"]).has(key) || value === undefined) {
      throw new Error(
        "Usage: staging:render:generate --config <input.json> --readiness <record.json> --output <render.yaml>",
      );
    }
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
    values.set(key, value);
  }
  for (const key of ["--config", "--readiness", "--output"]) {
    if (!values.has(key)) throw new Error(`Missing argument: ${key}`);
  }
  return Object.freeze({
    configPath: resolve(values.get("--config")),
    outputPath: resolve(values.get("--output")),
    readinessPath: resolve(values.get("--readiness")),
  });
}

async function readJson(path, field) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${field} could not be read as JSON`, { cause: error });
  }
}

export async function generateRenderBlueprint(arguments_, now = new Date()) {
  const paths = parseArguments(arguments_);
  if (paths.outputPath === paths.configPath || paths.outputPath === paths.readinessPath) {
    throw new Error("Blueprint output cannot overwrite an input file");
  }
  const [input, readiness] = await Promise.all([
    readJson(paths.configPath, "staging deployment input"),
    readJson(paths.readinessPath, "readiness record"),
  ]);
  const configuration = validateStagingDeploymentInput(input, readiness, now);
  const blueprint = serializeRenderBlueprint(createRenderBlueprint(configuration));
  await writeFile(paths.outputPath, blueprint, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify({
      event: "staging.render_blueprint.generated",
      outputPath: paths.outputPath,
      revision: configuration.release.revision,
      version: configuration.release.version,
    })}\n`,
  );
  return Object.freeze({ blueprint, outputPath: paths.outputPath });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await generateRenderBlueprint(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `Atlas Render Blueprint generation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
