import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger } from "../src/platform/logging/logger.js";

describe("structured logger redaction", () => {
  it("redacts authentication, staging, CSRF, and Financial idempotency headers", () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        chunks.push(chunk.toString("utf8"));
        callback();
      },
    });
    const logger = createLogger(
      {
        level: "info",
        environment: "local",
        applicationVersion: "test",
      },
      destination,
    );

    logger.info({
      req: {
        headers: {
          authorization: "Bearer fake-secret",
          cookie: "atlas_access=fake-secret",
          "cf-access-jwt-assertion": "fake-staging-assertion",
          "x-csrf-token": "fake-csrf-secret",
          "idempotency-key": "fake-idempotency-secret",
          accept: "application/json",
        },
      },
    });

    const record = JSON.parse(chunks.join("")) as {
      readonly req: { readonly headers: Readonly<Record<string, string>> };
    };
    expect(record.req.headers).toEqual({
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      "cf-access-jwt-assertion": "[REDACTED]",
      "x-csrf-token": "[REDACTED]",
      "idempotency-key": "[REDACTED]",
      accept: "application/json",
    });
    expect(chunks.join("")).not.toMatch(/fake-(?:secret|staging|csrf|idempotency)/);
  });
});
