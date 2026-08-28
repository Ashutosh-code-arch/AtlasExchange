import {
  notificationListResponseSchema,
  notificationMarkReadResponseSchema,
  type NotificationListResponse,
  type NotificationMarkReadResponse,
} from "@atlas/contracts";

import type { AuthenticationHttpClient } from "../../authentication";

export type NotificationPage = NotificationListResponse["data"];
export type NotificationReadReceipt = NotificationMarkReadResponse["data"]["readReceipt"];

export interface NotificationPageQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

export async function getNotificationPage(
  client: Pick<AuthenticationHttpClient, "request">,
  query: NotificationPageQuery = {},
): Promise<NotificationPage> {
  const search = new URLSearchParams();
  if (query.limit !== undefined) search.set("limit", String(query.limit));
  if (query.cursor !== undefined) search.set("cursor", query.cursor);
  const suffix = search.size === 0 ? "" : `?${search.toString()}`;
  const response = await client.request(`/api/v1/notifications${suffix}`, { method: "GET" });
  const payload = (await response.json()) as unknown;
  return notificationListResponseSchema.parse(payload).data;
}

export async function markNotificationRead(
  client: Pick<AuthenticationHttpClient, "request">,
  notificationId: string,
): Promise<NotificationReadReceipt> {
  const response = await client.request(`/api/v1/notifications/${notificationId}/read`, {
    method: "PATCH",
    csrf: true,
  });
  const payload = (await response.json()) as unknown;
  const receipt = notificationMarkReadResponseSchema.parse(payload).data.readReceipt;
  if (receipt.notificationId !== notificationId) {
    throw new Error("Notification read receipt does not match its requested resource.");
  }
  return receipt;
}
