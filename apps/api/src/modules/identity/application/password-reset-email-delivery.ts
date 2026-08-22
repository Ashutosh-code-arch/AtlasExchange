export interface DeliverPasswordResetEmailInput {
  readonly recipientEmail: string;
  readonly credential: string;
  readonly expiresAt: Date;
}

export type PasswordResetEmailDeliveryResult =
  { readonly status: "delivered" } | { readonly status: "failed" };

export interface PasswordResetEmailDelivery {
  deliver(input: DeliverPasswordResetEmailInput): Promise<PasswordResetEmailDeliveryResult>;
}
