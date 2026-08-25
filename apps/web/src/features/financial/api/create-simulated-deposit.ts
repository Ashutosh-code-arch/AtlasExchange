import {
  simulatedDepositRequestSchema,
  simulatedDepositResponseSchema,
  type SimulatedDeposit,
} from "@atlas/contracts";

import type { AuthenticationHttpClient } from "../../authentication";

export interface CreateSimulatedDepositInput {
  readonly assetCode: string;
  readonly amount: string;
  readonly idempotencyKey: string;
}

export async function createSimulatedDeposit(
  client: Pick<AuthenticationHttpClient, "request">,
  input: CreateSimulatedDepositInput,
): Promise<SimulatedDeposit> {
  const response = await client.request("/api/v1/deposits/simulated", {
    method: "POST",
    csrf: true,
    headers: { "idempotency-key": input.idempotencyKey },
    body: simulatedDepositRequestSchema.parse({
      assetCode: input.assetCode,
      amount: input.amount,
    }),
  });
  const payload = (await response.json()) as unknown;
  return simulatedDepositResponseSchema.parse(payload).data.deposit;
}
