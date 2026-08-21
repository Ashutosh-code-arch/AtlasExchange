export interface DeliverVerificationEmailInput {
  readonly recipientEmail: string;
  readonly credential: string;
  readonly expiresAt: Date;
}

export type VerificationEmailDeliveryResult =
  { readonly status: "delivered" } | { readonly status: "failed" };

export interface VerificationEmailDelivery {
  deliver(input: DeliverVerificationEmailInput): Promise<VerificationEmailDeliveryResult>;
}
