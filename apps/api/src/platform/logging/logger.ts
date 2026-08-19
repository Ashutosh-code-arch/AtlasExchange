import pino, { type Logger } from "pino";

import type { ApiConfig } from "../../config/config.js";

const REDACTED_PATHS = [
  "password",
  "token",
  "authorization",
  "req.headers.authorization",
  "req.headers.cookie",
  "database.url",
  "err.client.password",
  "err.client.connectionParameters.password",
];

export function createLogger(config: ApiConfig["logging"]): Logger {
  return pino({
    level: config.level,
    base: {
      service: "atlas-api",
      environment: config.environment,
      applicationVersion: config.applicationVersion,
    },
    redact: {
      paths: REDACTED_PATHS,
      censor: "[REDACTED]",
    },
    enabled: config.environment !== "test",
  });
}
