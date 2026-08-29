import { sql, type Kysely, type Transaction } from "kysely";

import {
  bindPostgresIdentityAdministrationStore,
  type IdentityAdministrationStore,
  type IdentityAdministrationUser,
  type IdentityDatabaseSchema,
} from "../../../identity/index.js";
import type {
  AdministrationUserCommandTransactionResult,
  AdministrationUserCommandTransactionRunner,
  ChangeAdministrationAdminRoleTransactionInput,
  ChangeAdministrationUserStateTransactionInput,
} from "../../application/administration-user-command-transaction.js";
import type {
  AdministrationAuditAction,
  CreateAdministrationAuditEventInput,
} from "../../domain/administration-audit-event.js";
import type { AdministrationDatabaseSchema } from "./administration-database-schema.js";
import { bindPostgresAdministrationAuditWriter } from "./postgres-administration-audit-writer.js";

type AdministrationCommandDatabaseSchema = AdministrationDatabaseSchema & IdentityDatabaseSchema;

interface ExistingAuditIntent {
  readonly actorUserId: string;
  readonly action: AdministrationAuditAction;
  readonly targetUserId: string;
  readonly reason: string;
  readonly details: CreateAdministrationAuditEventInput["details"];
}

function sameDetails(
  first: CreateAdministrationAuditEventInput["details"],
  second: CreateAdministrationAuditEventInput["details"],
): boolean {
  return (
    JSON.stringify(Object.entries(first).sort()) === JSON.stringify(Object.entries(second).sort())
  );
}

function sameIntent(
  existing: ExistingAuditIntent,
  expected: CreateAdministrationAuditEventInput,
): boolean {
  return (
    existing.actorUserId === expected.actorUserId &&
    existing.action === expected.action &&
    existing.targetUserId === expected.targetUserId &&
    existing.reason === expected.reason &&
    sameDetails(existing.details, expected.details)
  );
}

class PostgresAdministrationUserCommandTransaction {
  private readonly identity: IdentityAdministrationStore;

  public constructor(private readonly database: Transaction<AdministrationCommandDatabaseSchema>) {
    this.identity = bindPostgresIdentityAdministrationStore(database);
  }

  public async changeUserState(
    input: ChangeAdministrationUserStateTransactionInput,
  ): Promise<AdministrationUserCommandTransactionResult> {
    await this.lockOperation(input.operationId);
    const expected = stateAuditInput(input);
    const replay = await this.resolveReplay(expected);
    if (replay !== undefined) return replay;

    const user = await this.identity.lockUser(input.targetUserId);
    if (user === undefined) return { status: "not_found" };
    const previousState = input.state === "suspended" ? "active" : "suspended";
    if (user.state !== previousState) return { status: "state_conflict" };

    const changedAt = new Date(input.occurredAt);
    await this.identity.setAccountState(input.targetUserId, input.state, changedAt);
    await this.identity.revokeActiveSessions(
      input.targetUserId,
      changedAt,
      input.state === "suspended"
        ? "administration_user_suspended"
        : "administration_user_reactivated",
    );
    await bindPostgresAdministrationAuditWriter(this.database).appendOrGet(expected);
    return { status: "changed", user: await this.loadChangedUser(input.targetUserId) };
  }

  public async changeAdminRole(
    input: ChangeAdministrationAdminRoleTransactionInput,
  ): Promise<AdministrationUserCommandTransactionResult> {
    await this.lockOperation(input.operationId);
    await sql`SELECT pg_advisory_xact_lock(
      hashtextextended('administration:admin-role-mutation', 0)
    )`.execute(this.database);
    const expected = roleAuditInput(input);
    const replay = await this.resolveReplay(expected);
    if (replay !== undefined) return replay;

    const user = await this.identity.lockUser(input.targetUserId);
    if (user === undefined) return { status: "not_found" };
    if (user.state !== "active" || user.roles.includes("admin") === input.assigned) {
      return { status: "state_conflict" };
    }

    const changedAt = new Date(input.occurredAt);
    if (input.assigned) {
      await this.identity.grantAdminRole(input.targetUserId, input.actor.userId, changedAt);
    } else {
      await this.identity.revokeAdminRole(input.targetUserId);
    }
    await this.identity.revokeActiveSessions(
      input.targetUserId,
      changedAt,
      input.assigned ? "administration_admin_role_granted" : "administration_admin_role_revoked",
    );
    await bindPostgresAdministrationAuditWriter(this.database).appendOrGet(expected);
    return { status: "changed", user: await this.loadChangedUser(input.targetUserId) };
  }

  private async lockOperation(operationId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${operationId}, 0))`.execute(
      this.database,
    );
  }

  private async resolveReplay(
    expected: CreateAdministrationAuditEventInput,
  ): Promise<AdministrationUserCommandTransactionResult | undefined> {
    const existing = await this.database
      .selectFrom("administration.audit_events")
      .select([
        "actor_user_id as actorUserId",
        "action",
        "target_user_id as targetUserId",
        "reason",
        "details",
      ])
      .where("operation_id", "=", expected.operationId)
      .executeTakeFirst();
    if (existing === undefined) return undefined;
    if (!sameIntent(existing, expected)) {
      return { status: "idempotency_conflict" };
    }
    const user = await this.identity.findUser(expected.targetUserId);
    return user === undefined ? { status: "not_found" } : { status: "existing", user };
  }

  private async loadChangedUser(userId: string): Promise<IdentityAdministrationUser> {
    const user = await this.identity.findUser(userId);
    if (user === undefined) throw new Error("Changed Administration target could not be loaded");
    return user;
  }
}

function stateAuditInput(
  input: ChangeAdministrationUserStateTransactionInput,
): CreateAdministrationAuditEventInput {
  return input.state === "suspended"
    ? {
        operationId: input.operationId,
        actorUserId: input.actor.userId,
        actorSessionId: input.actor.sessionId,
        action: "identity.user_suspended",
        targetUserId: input.targetUserId,
        reason: input.reason,
        details: { previousState: "active", newState: "suspended" },
        requestId: input.actor.requestId,
        occurredAt: input.occurredAt,
      }
    : {
        operationId: input.operationId,
        actorUserId: input.actor.userId,
        actorSessionId: input.actor.sessionId,
        action: "identity.user_reactivated",
        targetUserId: input.targetUserId,
        reason: input.reason,
        details: { previousState: "suspended", newState: "active" },
        requestId: input.actor.requestId,
        occurredAt: input.occurredAt,
      };
}

function roleAuditInput(
  input: ChangeAdministrationAdminRoleTransactionInput,
): CreateAdministrationAuditEventInput {
  return {
    operationId: input.operationId,
    actorUserId: input.actor.userId,
    actorSessionId: input.actor.sessionId,
    action: input.assigned ? "identity.admin_role_granted" : "identity.admin_role_revoked",
    targetUserId: input.targetUserId,
    reason: input.reason,
    details: { role: "admin" },
    requestId: input.actor.requestId,
    occurredAt: input.occurredAt,
  };
}

export class PostgresAdministrationUserCommandTransactionRunner implements AdministrationUserCommandTransactionRunner {
  public constructor(private readonly database: Kysely<AdministrationCommandDatabaseSchema>) {}

  public changeUserState(
    input: ChangeAdministrationUserStateTransactionInput,
  ): Promise<AdministrationUserCommandTransactionResult> {
    return this.database
      .transaction()
      .execute((transaction) =>
        new PostgresAdministrationUserCommandTransaction(transaction).changeUserState(input),
      );
  }

  public changeAdminRole(
    input: ChangeAdministrationAdminRoleTransactionInput,
  ): Promise<AdministrationUserCommandTransactionResult> {
    return this.database
      .transaction()
      .execute((transaction) =>
        new PostgresAdministrationUserCommandTransaction(transaction).changeAdminRole(input),
      );
  }
}
