import { parseSimulatedDepositId } from "../domain/simulated-deposit.js";
import { parseWalletOwnerId } from "../domain/wallet.js";
import type { SimulatedDepositReader } from "./simulated-deposit-reader.js";

export interface GetSimulatedDepositCommand {
  readonly ownerId: string;
  readonly depositId: string;
}

export type GetSimulatedDepositResult =
  | { readonly status: "not_found" }
  | {
      readonly status: "found";
      readonly deposit: {
        readonly id: string;
        readonly walletId: string;
        readonly assetCode: string;
        readonly amount: string;
        readonly method: "simulated";
        readonly status: "credited";
        readonly creditedAt: string;
      };
    };

export class GetSimulatedDeposit {
  public constructor(private readonly reader: SimulatedDepositReader) {}

  public async execute(command: GetSimulatedDepositCommand): Promise<GetSimulatedDepositResult> {
    const ownerId = parseWalletOwnerId(command.ownerId);
    const depositId = parseSimulatedDepositId(command.depositId);
    const record = await this.reader.findByOwnerAndId(ownerId, depositId);

    return record === undefined
      ? { status: "not_found" }
      : {
          status: "found",
          deposit: {
            id: record.id,
            walletId: record.walletId,
            assetCode: record.amount.assetCode,
            amount: record.amount.toCanonicalDecimal(),
            method: record.method,
            status: record.status,
            creditedAt: record.creditedAt,
          },
        };
  }
}
