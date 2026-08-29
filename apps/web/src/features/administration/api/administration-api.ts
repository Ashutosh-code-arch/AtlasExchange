import {
  administrationChangeAdminRoleRequestSchema,
  administrationChangeUserStateRequestSchema,
  administrationMutationHeadersSchema,
  administrationUserParamsSchema,
  administrationUserResponseSchema,
  type AdministrationUser,
} from "@atlas/contracts";

import type { AuthenticationHttpClient } from "../../authentication";

type AdministrationClient = Pick<AuthenticationHttpClient, "request">;

function parseTarget(userId: string): string {
  return administrationUserParamsSchema.parse({ userId }).userId;
}

function parseOperationId(operationId: string): string {
  return administrationMutationHeadersSchema.parse({
    "idempotency-key": operationId,
  })["idempotency-key"];
}

async function parseUserResponse(
  response: Response,
  targetUserId: string,
): Promise<AdministrationUser> {
  const payload = (await response.json()) as unknown;
  const user = administrationUserResponseSchema.parse(payload).data.user;
  if (user.id !== targetUserId) {
    throw new Error("Administration response does not match its requested user.");
  }
  return user;
}

export async function getAdministrationUser(
  client: AdministrationClient,
  userId: string,
): Promise<AdministrationUser> {
  const targetUserId = parseTarget(userId);
  const response = await client.request(`/api/v1/administration/users/${targetUserId}`, {
    method: "GET",
  });
  return parseUserResponse(response, targetUserId);
}

export async function changeAdministrationUserState(
  client: AdministrationClient,
  input: {
    readonly userId: string;
    readonly operationId: string;
    readonly state: "active" | "suspended";
    readonly reason: string;
  },
): Promise<AdministrationUser> {
  const targetUserId = parseTarget(input.userId);
  const operationId = parseOperationId(input.operationId);
  const body = administrationChangeUserStateRequestSchema.parse({
    state: input.state,
    reason: input.reason,
  });
  const response = await client.request(`/api/v1/administration/users/${targetUserId}/state`, {
    method: "PATCH",
    csrf: true,
    headers: { "idempotency-key": operationId },
    body,
  });
  const user = await parseUserResponse(response, targetUserId);
  if (user.state !== input.state) {
    throw new Error("Administration state response does not match the requested transition.");
  }
  return user;
}

export async function changeAdministrationAdminRole(
  client: AdministrationClient,
  input: {
    readonly userId: string;
    readonly operationId: string;
    readonly assigned: boolean;
    readonly reason: string;
  },
): Promise<AdministrationUser> {
  const targetUserId = parseTarget(input.userId);
  const operationId = parseOperationId(input.operationId);
  const body = administrationChangeAdminRoleRequestSchema.parse({
    assigned: input.assigned,
    reason: input.reason,
  });
  const response = await client.request(
    `/api/v1/administration/users/${targetUserId}/roles/admin`,
    {
      method: "PATCH",
      csrf: true,
      headers: { "idempotency-key": operationId },
      body,
    },
  );
  const user = await parseUserResponse(response, targetUserId);
  if (user.roles.includes("admin") !== input.assigned) {
    throw new Error("Administration role response does not match the requested assignment.");
  }
  return user;
}
