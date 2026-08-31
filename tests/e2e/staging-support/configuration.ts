import { resolve } from "node:path";

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const revisionPattern = /^[0-9a-f]{40}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value === "" || value.trim() !== value) {
    throw new Error(`Missing or invalid staging smoke environment variable: ${name}`);
  }
  return value;
}

function exactHttpsOrigin(
  environment: NodeJS.ProcessEnv,
  name: string,
  registrableDomain: string,
): string {
  const value = requiredEnvironment(environment, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an exact HTTPS origin`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.hostname.endsWith(`.${registrableDomain}`) ||
    url.hostname.endsWith(".onrender.com") ||
    url.hostname.endsWith(".example") ||
    url.hostname.endsWith(".test")
  ) {
    throw new Error(`${name} must be an exact Atlas custom HTTPS origin`);
  }
  return url.origin;
}

function matchingValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  pattern: RegExp,
  requirement: string,
): string {
  const value = requiredEnvironment(environment, name);
  if (!pattern.test(value)) throw new Error(`${name} must be ${requirement}`);
  return value;
}

export interface StagingSmokeConfiguration {
  readonly apiOrigin: string;
  readonly evidencePath: string;
  readonly expectedEmail: string;
  readonly expectedVersion: string;
  readonly release: Readonly<{
    apiImageDigest: string;
    metricsCollectorImageDigest: string;
    revision: string;
    webImageDigest: string;
  }>;
  readonly secrets: Readonly<{
    accessClientId: string;
    accessClientSecret: string;
    accountPassword: string;
  }>;
  readonly webOrigin: string;
}

export function parseStagingSmokeConfiguration(
  environment: NodeJS.ProcessEnv,
): StagingSmokeConfiguration {
  const registrableDomain = requiredEnvironment(environment, "ATLAS_STAGING_REGISTRABLE_DOMAIN");
  if (
    registrableDomain !== registrableDomain.toLowerCase() ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(registrableDomain) ||
    ["example.com", "example.net", "example.org"].includes(registrableDomain) ||
    registrableDomain.endsWith(".onrender.com") ||
    registrableDomain === "onrender.com" ||
    registrableDomain.endsWith(".cloudflareaccess.com") ||
    registrableDomain === "cloudflareaccess.com" ||
    [".example", ".invalid", ".localhost", ".test"].some((suffix) =>
      registrableDomain.endsWith(suffix),
    )
  ) {
    throw new Error("ATLAS_STAGING_REGISTRABLE_DOMAIN must be an Atlas-owned public domain");
  }
  const apiOrigin = exactHttpsOrigin(environment, "ATLAS_STAGING_API_ORIGIN", registrableDomain);
  const webOrigin = exactHttpsOrigin(environment, "ATLAS_STAGING_WEB_ORIGIN", registrableDomain);
  if (apiOrigin === webOrigin) {
    throw new Error("Staging web and API origins must be distinct");
  }

  const expectedEmail = requiredEnvironment(environment, "ATLAS_STAGING_SMOKE_EMAIL");
  if (!/^[^@\s]+@[^@\s]+$/.test(expectedEmail)) {
    throw new Error("ATLAS_STAGING_SMOKE_EMAIL must be a valid synthetic account email");
  }

  return Object.freeze({
    apiOrigin,
    evidencePath: resolve(requiredEnvironment(environment, "ATLAS_STAGING_SMOKE_EVIDENCE_PATH")),
    expectedEmail,
    expectedVersion: matchingValue(
      environment,
      "ATLAS_STAGING_EXPECTED_VERSION",
      versionPattern,
      "a stable semantic version",
    ),
    release: Object.freeze({
      apiImageDigest: matchingValue(
        environment,
        "ATLAS_STAGING_API_IMAGE_DIGEST",
        digestPattern,
        "an immutable SHA-256 digest",
      ),
      metricsCollectorImageDigest: matchingValue(
        environment,
        "ATLAS_STAGING_METRICS_COLLECTOR_IMAGE_DIGEST",
        digestPattern,
        "an immutable SHA-256 digest",
      ),
      revision: matchingValue(
        environment,
        "ATLAS_STAGING_RELEASE_REVISION",
        revisionPattern,
        "a full lowercase Git commit",
      ),
      webImageDigest: matchingValue(
        environment,
        "ATLAS_STAGING_WEB_IMAGE_DIGEST",
        digestPattern,
        "an immutable SHA-256 digest",
      ),
    }),
    secrets: Object.freeze({
      accessClientId: requiredEnvironment(environment, "ATLAS_STAGING_ACCESS_CLIENT_ID"),
      accessClientSecret: requiredEnvironment(environment, "ATLAS_STAGING_ACCESS_CLIENT_SECRET"),
      accountPassword: requiredEnvironment(environment, "ATLAS_STAGING_SMOKE_PASSWORD"),
    }),
    webOrigin,
  });
}
