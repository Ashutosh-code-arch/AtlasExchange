import { cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";

import { argon2id, hash } from "argon2";

interface Candidate {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

const candidates: readonly Candidate[] = [
  { memoryCost: 19_456, timeCost: 2, parallelism: 1 },
  { memoryCost: 32_768, timeCost: 3, parallelism: 1 },
  { memoryCost: 65_536, timeCost: 3, parallelism: 1 },
];
const sampleCount = 7;
const benchmarkPassword = "atlas-benchmark-password-of-realistic-length";

function percentile(sortedSamples: readonly number[], percentileValue: number): number {
  const index = Math.ceil(sortedSamples.length * percentileValue) - 1;
  return sortedSamples[Math.max(0, index)] ?? 0;
}

async function measure(candidate: Candidate): Promise<readonly number[]> {
  const options = {
    ...candidate,
    type: argon2id,
    hashLength: 32,
  } as const;

  await hash(benchmarkPassword, options);
  const samples: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = performance.now();
    await hash(benchmarkPassword, options);
    samples.push(performance.now() - startedAt);
  }
  return samples.sort((left, right) => left - right);
}

process.stdout.write(
  `${JSON.stringify({
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpuCount: cpus().length,
      memoryMiB: Math.round(totalmem() / 1_048_576),
    },
    sampleCount,
  })}\n`,
);

for (const candidate of candidates) {
  const samples = await measure(candidate);
  process.stdout.write(
    `${JSON.stringify({
      ...candidate,
      medianMs: Number(percentile(samples, 0.5).toFixed(1)),
      p95Ms: Number(percentile(samples, 0.95).toFixed(1)),
      samplesMs: samples.map((sample) => Number(sample.toFixed(1))),
    })}\n`,
  );
}
