import {
  simulatedWithdrawalRequestSchema,
  simulatedWithdrawalResponseSchema,
  type SimulatedWithdrawal,
} from "@atlas/contracts";

import type { AuthenticationHttpClient } from "../../authentication";

export interface CreateSimulatedWithdrawalInput {
  readonly assetCode: string;
  readonly amount: string;
  readonly idempotencyKey: string;
}

export async function createSimulatedWithdrawal(
  client: Pick<AuthenticationHttpClient, "request">,
  input: CreateSimulatedWithdrawalInput,
): Promise<SimulatedWithdrawal> {
  const response = await client.request("/api/v1/withdrawals/simulated", {
    method: "POST",
    csrf: true,
    headers: { "idempotency-key": input.idempotencyKey },
    body: simulatedWithdrawalRequestSchema.parse({
      assetCode: input.assetCode,
      amount: input.amount,
    }),
  });
  const payload = (await response.json()) as unknown;
  return simulatedWithdrawalResponseSchema.parse(payload).data.withdrawal;
}
