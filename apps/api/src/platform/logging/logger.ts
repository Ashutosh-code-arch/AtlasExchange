import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

import type { ApiConfig } from "../../config/config.js";

const REDACTED_PATHS = [
  "password",
  "token",
  "authorization",
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["cf-access-jwt-assertion"]',
  'req.headers["x-atlas-gateway-secret"]',
  'req.headers["x-csrf-token"]',
  'req.headers["idempotency-key"]',
  "database.url",
  "err.client.password",
  "err.client.connectionParameters.password",
];

export function createLogger(
  config: ApiConfig["logging"],
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
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
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
