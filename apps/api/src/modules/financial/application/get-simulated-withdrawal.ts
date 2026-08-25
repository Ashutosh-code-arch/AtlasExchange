import { parseSimulatedWithdrawalId } from "../domain/simulated-withdrawal.js";
import { parseWalletOwnerId } from "../domain/wallet.js";
import type { SimulatedWithdrawalReader } from "./simulated-withdrawal-reader.js";

export interface GetSimulatedWithdrawalCommand {
  readonly ownerId: string;
  readonly withdrawalId: string;
}

export type GetSimulatedWithdrawalResult =
  | { readonly status: "not_found" }
  | {
      readonly status: "found";
      readonly withdrawal: {
        readonly id: string;
        readonly walletId: string;
        readonly assetCode: string;
        readonly amount: string;
        readonly method: "simulated";
        readonly status: "completed";
        readonly completedAt: string;
      };
    };

export class GetSimulatedWithdrawal {
  public constructor(private readonly reader: SimulatedWithdrawalReader) {}

  public async execute(
    command: GetSimulatedWithdrawalCommand,
  ): Promise<GetSimulatedWithdrawalResult> {
    const ownerId = parseWalletOwnerId(command.ownerId);
    const withdrawalId = parseSimulatedWithdrawalId(command.withdrawalId);
    const record = await this.reader.findByOwnerAndId(ownerId, withdrawalId);

    return record === undefined
      ? { status: "not_found" }
      : {
          status: "found",
          withdrawal: {
            id: record.id,
            walletId: record.walletId,
            assetCode: record.amount.assetCode,
            amount: record.amount.toCanonicalDecimal(),
            method: record.method,
            status: record.status,
            completedAt: record.completedAt,
          },
        };
  }
}
