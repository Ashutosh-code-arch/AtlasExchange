import type { IdentityAdministrationUser } from "../../identity/index.js";
import type { AdministrationActor } from "./administration-authorization.js";

interface AdministrationUserCommandInput {
  readonly actor: AdministrationActor;
  readonly operationId: string;
  readonly targetUserId: string;
  readonly reason: string;
  readonly occurredAt: string;
}

export interface ChangeAdministrationUserStateTransactionInput extends AdministrationUserCommandInput {
  readonly state: "active" | "suspended";
}

export interface ChangeAdministrationAdminRoleTransactionInput extends AdministrationUserCommandInput {
  readonly assigned: boolean;
}

export type AdministrationUserCommandTransactionResult =
  | {
      readonly status: "changed" | "existing";
      readonly user: IdentityAdministrationUser;
    }
  | { readonly status: "idempotency_conflict" | "not_found" | "state_conflict" };

export interface AdministrationUserCommandTransactionRunner {
  changeUserState(
    input: ChangeAdministrationUserStateTransactionInput,
  ): Promise<AdministrationUserCommandTransactionResult>;
  changeAdminRole(
    input: ChangeAdministrationAdminRoleTransactionInput,
  ): Promise<AdministrationUserCommandTransactionResult>;
}
