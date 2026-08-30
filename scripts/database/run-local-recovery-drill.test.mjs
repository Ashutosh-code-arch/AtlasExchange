import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertSafeRecoveryDatabaseName,
  createLocalDatabaseUrl,
  createRecoveryDatabaseName,
  createRecoveryEvidence,
} from "./run-local-recovery-drill.mjs";

describe("local PostgreSQL recovery drill", () => {
  it("generates only isolated disposable database names", () => {
    assert.equal(
      createRecoveryDatabaseName("0123456789abcdef"),
      "atlas_recovery_drill_0123456789abcdef",
    );
    for (const name of [
      "atlas",
      "postgres",
      "atlas_recovery_drill_0123",
      "atlas_recovery_drill_0123456789abcdef;drop database atlas",
    ]) {
      assert.throws(() => assertSafeRecoveryDatabaseName(name), /disposable namespace/);
    }
  });

  it("constructs the local target URL without accepting an unsafe database or port", () => {
    const url = new URL(createLocalDatabaseUrl("atlas_recovery_drill_0123456789abcdef", "55432"));
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, "55432");
    assert.equal(url.pathname, "/atlas_recovery_drill_0123456789abcdef");
    assert.throws(
      () => createLocalDatabaseUrl("atlas_recovery_drill_0123456789abcdef", "70000"),
      /valid TCP port/,
    );
  });

  it("emits evidence only for a successful PostgreSQL 18 validation", () => {
    const evidence = createRecoveryEvidence({
      archiveBytes: 4_096,
      archiveSha256: "a".repeat(64),
      completedAt: "2026-08-30T12:00:00.000Z",
      durationMilliseconds: 1_234,
      postgresVersion: "postgres (PostgreSQL) 18.4 (Debian 18.4-1.pgdg13+1)",
      validation: { passed: true, checks: [] },
    });

    assert.deepEqual(evidence.backup, {
      format: "postgresql-custom",
      archiveBytes: 4_096,
      archiveSha256: "a".repeat(64),
      retained: false,
    });
    assert.equal(evidence.restore.validation.passed, true);
    assert.throws(
      () =>
        createRecoveryEvidence({
          archiveBytes: 4_096,
          archiveSha256: "a".repeat(64),
          completedAt: "2026-08-30T12:00:00.000Z",
          durationMilliseconds: 1_234,
          postgresVersion: "postgres (PostgreSQL) 18.4",
          validation: { passed: false },
        }),
      /must pass/,
    );
  });
});
