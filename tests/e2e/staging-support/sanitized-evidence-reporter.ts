import { writeFile } from "node:fs/promises";

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

import { parseStagingSmokeConfiguration } from "./configuration.js";

interface CheckResult {
  readonly durationMs: number;
  readonly name: string;
  readonly status: TestResult["status"];
}

const expectedCheckNames = new Set([
  "proves lifecycle readiness and exact API release identity",
  "proves the protected web shell and runtime API contract",
  "validates public asset, market, and Market Data contracts",
  "validates a synthetic session and owner-scoped read models",
]);

export default class SanitizedEvidenceReporter implements Reporter {
  private readonly checks: CheckResult[] = [];
  private observedAt = new Date();

  public onBegin(_config: FullConfig, _suite: Suite): void {
    this.observedAt = new Date();
  }

  public onTestEnd(test: TestCase, result: TestResult): void {
    const check = Object.freeze({
      durationMs: result.duration,
      name: test.title,
      status: result.status,
    });
    this.checks.push(check);
    process.stdout.write(
      `${JSON.stringify({
        event: "staging.smoke_check.completed",
        name: check.name,
        status: check.status,
        durationMs: check.durationMs,
      })}\n`,
    );
  }

  public printsToStdio(): boolean {
    return true;
  }

  public async onEnd(result: FullResult): Promise<{ status?: FullResult["status"] }> {
    const configuration = parseStagingSmokeConfiguration(process.env);
    const expiresAt = new Date(this.observedAt.getTime() + 24 * 60 * 60 * 1_000);
    const completedExpectedChecks =
      this.checks.length === expectedCheckNames.size &&
      this.checks.every((check) => expectedCheckNames.has(check.name) && check.status === "passed");
    const outcome = result.status === "passed" && completedExpectedChecks ? "passed" : "failed";
    const evidence = {
      schemaVersion: 1,
      environment: "staging",
      release: {
        version: configuration.expectedVersion,
        revision: configuration.release.revision,
        apiImageDigest: configuration.release.apiImageDigest,
        webImageDigest: configuration.release.webImageDigest,
        metricsCollectorImageDigest: configuration.release.metricsCollectorImageDigest,
      },
      endpoints: {
        apiOrigin: configuration.apiOrigin,
        webOrigin: configuration.webOrigin,
      },
      observedAt: this.observedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      outcome,
      scope: "read-only-partial",
      checks: this.checks,
    };

    try {
      await writeFile(configuration.evidencePath, `${JSON.stringify(evidence, undefined, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      process.stdout.write(
        `${JSON.stringify({
          event: "staging.smoke_evidence.written",
          evidencePath: configuration.evidencePath,
          outcome: evidence.outcome,
          releaseVersion: configuration.expectedVersion,
        })}\n`,
      );
      return outcome === "passed" ? {} : { status: "failed" };
    } catch {
      process.stderr.write("Staging smoke evidence could not be written safely.\n");
      return { status: "failed" };
    }
  }
}
