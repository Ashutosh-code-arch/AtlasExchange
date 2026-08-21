import * as nodemailer from "nodemailer";
import type { Logger } from "pino";

import type {
  DeliverVerificationEmailInput,
  VerificationEmailDelivery,
  VerificationEmailDeliveryResult,
} from "../../application/verification-email-delivery.js";

export interface SmtpVerificationEmailDeliveryOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly requireTls: boolean;
  readonly from: string;
  readonly webOrigin: string;
  readonly logger: Logger;
  readonly username?: string;
  readonly password?: string;
}

function safeDeliveryError(error: unknown): Readonly<Record<string, unknown>> {
  if (!(error instanceof Error)) {
    return { name: "Error", code: "EMAIL_DELIVERY_FAILED" };
  }

  return {
    name: error.name,
    code: "code" in error && typeof error.code === "string" ? error.code : "EMAIL_DELIVERY_FAILED",
  };
}

export class SmtpVerificationEmailDelivery implements VerificationEmailDelivery {
  private readonly transporter;

  public constructor(private readonly options: SmtpVerificationEmailDeliveryOptions) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      requireTLS: options.requireTls,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
      ...(options.username === undefined || options.password === undefined
        ? {}
        : { auth: { user: options.username, pass: options.password } }),
    });
  }

  public async deliver(
    input: DeliverVerificationEmailInput,
  ): Promise<VerificationEmailDeliveryResult> {
    const verificationUrl = new URL("/verify-email", this.options.webOrigin);
    verificationUrl.hash = new URLSearchParams({ token: input.credential }).toString();

    try {
      await this.transporter.sendMail({
        from: this.options.from,
        to: input.recipientEmail,
        subject: "Verify your Atlas Exchange email",
        text: [
          "Verify your Atlas Exchange email address:",
          verificationUrl.toString(),
          "",
          `This link expires at ${input.expiresAt.toISOString()}.`,
          "If you did not create this account, you can ignore this email.",
        ].join("\n"),
      });
      return { status: "delivered" };
    } catch (error) {
      this.options.logger.error(
        {
          event: "identity.verification_email.delivery_failed",
          deliveryError: safeDeliveryError(error),
        },
        "Verification email delivery failed",
      );
      return { status: "failed" };
    }
  }
}
