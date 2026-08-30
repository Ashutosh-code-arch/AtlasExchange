import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scanPath, scanText } from "./scan-tracked-secrets.mjs";

describe("tracked-secret scanning", () => {
  it("detects representative credential material without returning its value", () => {
    const token = ["ghp", "_", "a".repeat(36)].join("");
    const findings = scanText(`first line\n${token}\n`, "example.txt");

    assert.deepEqual(findings, [
      {
        line: 2,
        path: "example.txt",
        ruleId: "github-token",
      },
    ]);
    assert.equal(JSON.stringify(findings).includes(token), false);
  });

  it("detects private keys and reports their first matching line", () => {
    const marker = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
    assert.deepEqual(scanText(`comment\n${marker}\n`, "secret.pem"), [
      {
        line: 2,
        path: "secret.pem",
        ruleId: "private-key",
      },
    ]);
  });

  it("rejects credential-bearing filenames but permits documentation templates", () => {
    assert.equal(scanPath("apps/api/.env.production").length, 1);
    assert.equal(scanPath("certificates/signing.p12").length, 1);
    assert.deepEqual(scanPath("apps/api/.env.example"), []);
    assert.deepEqual(scanPath("apps/api/.env.test.example"), []);
    assert.deepEqual(scanPath("docs/example.pem"), []);
  });

  it("does not flag placeholders or ordinary configuration", () => {
    assert.deepEqual(
      scanText("POSTGRES_PASSWORD=atlas_test_only\nTOKEN=replace-me\n", "config.example"),
      [],
    );
  });
});
