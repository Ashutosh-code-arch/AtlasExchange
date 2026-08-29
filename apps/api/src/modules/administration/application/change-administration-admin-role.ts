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

export type ChangeAdministrationAdminRoleResult =
  AdministrationUserCommandTransactionResult | { readonly status: "self_target_forbidden" };

export class ChangeAdministrationAdminRole {
  private readonly now: () => Date;

  public constructor(
    private readonly transactions: Pick<
      AdministrationUserCommandTransactionRunner,
      "changeAdminRole"
    >,
    options: { readonly now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public async execute(input: {
    readonly context: AuthenticatedContext;
    readonly operationId: string;
    readonly targetUserId: string;
    readonly assigned: boolean;
    readonly reason: string;
  }): Promise<ChangeAdministrationAdminRoleResult> {
    const actor = requireAdministrationAuthorization(input.context, "administration.roles.manage");
    if (actor.userId === input.targetUserId) {
      return { status: "self_target_forbidden" };
    }
    const occurredAt = this.now().toISOString();
    validateRoleCommand(actor, input, occurredAt);
    return this.transactions.changeAdminRole({
      actor,
      operationId: input.operationId,
      targetUserId: input.targetUserId,
      assigned: input.assigned,
      reason: input.reason,
      occurredAt,
    });
  }
}

function validateRoleCommand(
  actor: AdministrationActor,
  input: {
    readonly operationId: string;
    readonly targetUserId: string;
    readonly assigned: boolean;
    readonly reason: string;
  },
  occurredAt: string,
): void {
  parseCreateAdministrationAuditEventInput({
    operationId: input.operationId,
    actorUserId: actor.userId,
    actorSessionId: actor.sessionId,
    action: input.assigned ? "identity.admin_role_granted" : "identity.admin_role_revoked",
    targetUserId: input.targetUserId,
    reason: input.reason,
    details: { role: "admin" },
    requestId: actor.requestId,
    occurredAt,
  });
}
