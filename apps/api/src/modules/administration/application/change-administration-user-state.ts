import type { AuthenticatedContext } from "../../identity/index.js";
import { parseCreateAdministrationAuditEventInput } from "../domain/administration-audit-event.js";
import {
  requireAdministrationAuthorization,
  type AdministrationActor,
} from "./administration-authorization.js";
import type {
  AdministrationUserCommandTransactionResult,
  AdministrationUserCommandTransactionRunner,
} from "./administration-user-command-transaction.js";

export type ChangeAdministrationUserStateResult =
  AdministrationUserCommandTransactionResult | { readonly status: "self_target_forbidden" };

export class ChangeAdministrationUserState {
  private readonly now: () => Date;

  public constructor(
    private readonly transactions: Pick<
      AdministrationUserCommandTransactionRunner,
      "changeUserState"
    >,
    options: { readonly now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public async execute(input: {
    readonly context: AuthenticatedContext;
    readonly operationId: string;
    readonly targetUserId: string;
    readonly state: "active" | "suspended";
    readonly reason: string;
  }): Promise<ChangeAdministrationUserStateResult> {
    const actor = requireAdministrationAuthorization(
      input.context,
      "administration.users.change_state",
    );
    if (actor.userId === input.targetUserId) {
      return { status: "self_target_forbidden" };
    }
    const occurredAt = this.now().toISOString();
    validateStateCommand(actor, input, occurredAt);
    return this.transactions.changeUserState({
      actor,
      operationId: input.operationId,
      targetUserId: input.targetUserId,
      state: input.state,
      reason: input.reason,
      occurredAt,
    });
  }
}

function validateStateCommand(
  actor: AdministrationActor,
  input: {
    readonly operationId: string;
    readonly targetUserId: string;
    readonly state: "active" | "suspended";
    readonly reason: string;
  },
  occurredAt: string,
): void {
  parseCreateAdministrationAuditEventInput({
    operationId: input.operationId,
    actorUserId: actor.userId,
    actorSessionId: actor.sessionId,
    action: input.state === "suspended" ? "identity.user_suspended" : "identity.user_reactivated",
    targetUserId: input.targetUserId,
    reason: input.reason,
    details:
      input.state === "suspended"
        ? { previousState: "active", newState: "suspended" }
        : { previousState: "suspended", newState: "active" },
    requestId: actor.requestId,
    occurredAt,
  });
}
