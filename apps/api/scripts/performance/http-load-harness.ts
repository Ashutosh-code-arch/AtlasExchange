import { request as httpRequest, type Agent } from "node:http";
import { request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";

export interface HttpLoadScenario {
  readonly target: URL;
  readonly requestCount: number;
  readonly concurrency: number;
  readonly requestTimeoutMilliseconds: number;
}

export interface HttpLoadResult {
  readonly requestCount: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  readonly durationMilliseconds: number;
  readonly requestsPerSecond: number;
  readonly latencyMilliseconds: Readonly<{
    minimum: number;
    median: number;
    p95: number;
    p99: number;
    maximum: number;
  }>;
}

interface RequestResult {
  readonly successful: boolean;
  readonly durationMilliseconds: number;
}

export function percentile(sortedSamples: readonly number[], quantile: number): number {
  if (sortedSamples.length === 0) return 0;
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new RangeError("Percentile quantile must be between zero and one.");
  }
  const index = Math.max(0, Math.ceil(sortedSamples.length * quantile) - 1);
  return sortedSamples[index] ?? sortedSamples.at(-1) ?? 0;
}

function round(value: number, fractionDigits = 2): number {
  return Number(value.toFixed(fractionDigits));
}

function validateScenario(scenario: HttpLoadScenario): void {
  if (
    !Number.isInteger(scenario.requestCount) ||
    scenario.requestCount <= 0 ||
    !Number.isInteger(scenario.concurrency) ||
    scenario.concurrency <= 0 ||
    scenario.concurrency > scenario.requestCount ||
    !Number.isInteger(scenario.requestTimeoutMilliseconds) ||
    scenario.requestTimeoutMilliseconds <= 0 ||
    (scenario.target.protocol !== "http:" && scenario.target.protocol !== "https:")
  ) {
    throw new RangeError("HTTP load scenario is invalid.");
  }
}

async function executeRequest(
  target: URL,
  agent: Agent,
  timeoutMilliseconds: number,
): Promise<RequestResult> {
  const startedAt = performance.now();
  return await new Promise<RequestResult>((resolve) => {
    let settled = false;
    const finish = (successful: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ successful, durationMilliseconds: performance.now() - startedAt });
    };
    const performRequest = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = performRequest(
      target,
      {
        agent,
        method: "GET",
        headers: { accept: "application/json" },
      },
      (response) => {
        response.resume();
        response.once("end", () => finish(response.statusCode === 200));
        response.once("aborted", () => finish(false));
        response.once("error", () => finish(false));
      },
    );
    request.setTimeout(timeoutMilliseconds, () => {
      request.destroy(new Error("HTTP performance request timed out."));
    });
    request.once("error", () => {
      finish(false);
    });
    request.end();
  });
}

export async function runHttpLoad(
  scenario: HttpLoadScenario,
  agent: Agent,
): Promise<HttpLoadResult> {
  validateScenario(scenario);
  const samples = new Array<number>(scenario.requestCount);
  let nextRequestIndex = 0;
  let successfulRequests = 0;
  const startedAt = performance.now();

  async function worker(): Promise<void> {
    while (nextRequestIndex < scenario.requestCount) {
      const requestIndex = nextRequestIndex;
      nextRequestIndex += 1;
      const result = await executeRequest(
        scenario.target,
        agent,
        scenario.requestTimeoutMilliseconds,
      );
      samples[requestIndex] = result.durationMilliseconds;
      if (result.successful) successfulRequests += 1;
    }
  }

  await Promise.all(Array.from({ length: scenario.concurrency }, () => worker()));
  const durationMilliseconds = performance.now() - startedAt;
  const sortedSamples = [...samples].sort((left, right) => left - right);

  return {
    requestCount: scenario.requestCount,
    successfulRequests,
    failedRequests: scenario.requestCount - successfulRequests,
    durationMilliseconds: round(durationMilliseconds),
    requestsPerSecond: round(scenario.requestCount / (durationMilliseconds / 1_000)),
    latencyMilliseconds: {
      minimum: round(sortedSamples[0] ?? 0),
      median: round(percentile(sortedSamples, 0.5)),
      p95: round(percentile(sortedSamples, 0.95)),
      p99: round(percentile(sortedSamples, 0.99)),
      maximum: round(sortedSamples.at(-1) ?? 0),
    },
  };
}
