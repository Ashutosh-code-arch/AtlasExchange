import { z } from "zod";

import { AdministrationAuditInvariantError } from "./administration-audit-invariant-error.js";

export const administrationAuditActions = [
  "identity.user_suspended",
  "identity.user_reactivated",
  "identity.admin_role_granted",
  "identity.admin_role_revoked",
] as const;

export type AdministrationAuditAction = (typeof administrationAuditActions)[number];

const uuidSchema = z.uuid();
const requestIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const reasonSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((reason) => reason === reason.trim())
  .refine((reason) =>
    Array.from(reason).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
    }),
  );
const baseFields = {
  operationId: uuidSchema,
  actorUserId: uuidSchema,
  actorSessionId: uuidSchema,
  targetUserId: uuidSchema,
  reason: reasonSchema,
  requestId: requestIdSchema,
  occurredAt: z.iso.datetime(),
} as const;

const administrationAuditInputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...baseFields,
    action: z.literal("identity.user_suspended"),
    details: z.strictObject({
      previousState: z.literal("active"),
      newState: z.literal("suspended"),
    }),
  }),
  z.strictObject({
    ...baseFields,
    action: z.literal("identity.user_reactivated"),
    details: z.strictObject({
      previousState: z.literal("suspended"),
      newState: z.literal("active"),
    }),
  }),
  z.strictObject({
    ...baseFields,
    action: z.literal("identity.admin_role_granted"),
    details: z.strictObject({ role: z.literal("admin") }),
  }),
  z.strictObject({
    ...baseFields,
    action: z.literal("identity.admin_role_revoked"),
    details: z.strictObject({ role: z.literal("admin") }),
  }),
]);

export type CreateAdministrationAuditEventInput = z.infer<typeof administrationAuditInputSchema>;

export type RestoreAdministrationAuditEventInput = CreateAdministrationAuditEventInput & {
  readonly id: string;
  readonly createdAt: string;
};

function issueForInvalidInput(input: unknown): AdministrationAuditInvariantError {
  const shape = z
    .strictObject({
      operationId: z.unknown(),
      actorUserId: z.unknown(),
      actorSessionId: z.unknown(),
      action: z.unknown(),
      targetUserId: z.unknown(),
      reason: z.unknown(),
      details: z.unknown(),
      requestId: z.unknown(),
      occurredAt: z.unknown(),
    })
    .safeParse(input);
  const value = shape.success ? shape.data : undefined;
  if (typeof value?.operationId !== "string" || !uuidSchema.safeParse(value.operationId).success) {
    return new AdministrationAuditInvariantError("ADMINISTRATION_AUDIT_OPERATION_ID_INVALID");
  }
  if (
    typeof value.actorUserId !== "string" ||
    !uuidSchema.safeParse(value.actorUserId).success ||
    typeof value.actorSessionId !== "string" ||
    !uuidSchema.safeParse(value.actorSessionId).success
  ) {
    return new AdministrationAuditInvariantError("ADMINISTRATION_AUDIT_ACTOR_INVALID");
  }
  if (typeof value.targetUserId !== "string" || !uuidSchema.safeParse(value.targetUserId).success) {
    return new AdministrationAuditInvariantError("ADMINISTRATION_AUDIT_TARGET_INVALID");
  }
  if (typeof value.reason !== "string" || !reasonSchema.safeParse(value.reason).success) {
    return new AdministrationAuditInvariantError("ADMINISTRATION_AUDIT_REASON_INVALID");
  }
  if (typeof value.requestId !== "string" || !requestIdSchema.safeParse(value.requestId).success) {
    return new AdministrationAuditInvariantError("ADMINISTRATION_AUDIT_REQUEST_ID_INVALID");
  }
  if (
    typeof value.occurredAt !== "string" ||
    !z.iso.datetime().safeParse(value.occurredAt).success
  ) {
    return new AdministrationAuditInvariantError("ADMINISTRATION_AUDIT_OCCURRED_AT_INVALID");
  }
  return new AdministrationAuditInvariantError("ADMINISTRATION_AUDIT_DETAILS_INVALID");
}

export function parseCreateAdministrationAuditEventInput(
  input: unknown,
): CreateAdministrationAuditEventInput {
  const result = administrationAuditInputSchema.safeParse(input);
  if (!result.success) throw issueForInvalidInput(input);
  Object.freeze(result.data.details);
  return Object.freeze(result.data);
}

export class AdministrationAuditEventRecord {
  private constructor(
    public readonly id: string,
    public readonly operationId: string,
    public readonly actorUserId: string,
    public readonly actorSessionId: string,
    public readonly action: AdministrationAuditAction,
    public readonly targetUserId: string,
    public readonly reason: string,
    public readonly details: CreateAdministrationAuditEventInput["details"],
    public readonly requestId: string,
    public readonly occurredAt: string,
    public readonly createdAt: string,
  ) {
    Object.freeze(this.details);
    Object.freeze(this);
  }

  public static restore(
    input: RestoreAdministrationAuditEventInput,
  ): AdministrationAuditEventRecord {
    if (!uuidSchema.safeParse(input.id).success) {
      throw new AdministrationAuditInvariantError("ADMINISTRATION_AUDIT_ID_INVALID");
    }
    const parsed = parseCreateAdministrationAuditEventInput({
      operationId: input.operationId,
      actorUserId: input.actorUserId,
      actorSessionId: input.actorSessionId,
      action: input.action,
      targetUserId: input.targetUserId,
      reason: input.reason,
      details: input.details,
      requestId: input.requestId,
      occurredAt: input.occurredAt,
    });
    if (!z.iso.datetime().safeParse(input.createdAt).success) {
      throw new AdministrationAuditInvariantError("ADMINISTRATION_AUDIT_CREATED_AT_INVALID");
    }
    return new AdministrationAuditEventRecord(
      input.id,
      parsed.operationId,
      parsed.actorUserId,
      parsed.actorSessionId,
      parsed.action,
      parsed.targetUserId,
      parsed.reason,
      parsed.details,
      parsed.requestId,
      parsed.occurredAt,
      input.createdAt,
    );
  }
}
