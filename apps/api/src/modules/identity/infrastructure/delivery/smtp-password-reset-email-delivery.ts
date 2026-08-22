import * as nodemailer from "nodemailer";
import type { Logger } from "pino";

import type {
  DeliverPasswordResetEmailInput,
  PasswordResetEmailDelivery,
  PasswordResetEmailDeliveryResult,
} from "../../application/password-reset-email-delivery.js";

export interface SmtpPasswordResetEmailDeliveryOptions {
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

export class SmtpPasswordResetEmailDelivery implements PasswordResetEmailDelivery {
  private readonly transporter;

  public constructor(private readonly options: SmtpPasswordResetEmailDeliveryOptions) {
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
    input: DeliverPasswordResetEmailInput,
  ): Promise<PasswordResetEmailDeliveryResult> {
    const resetUrl = new URL("/reset-password", this.options.webOrigin);
    resetUrl.hash = new URLSearchParams({ token: input.credential }).toString();

    try {
      await this.transporter.sendMail({
        from: this.options.from,
        to: input.recipientEmail,
        subject: "Reset your Atlas Exchange password",
        text: [
          "Reset your Atlas Exchange password:",
          resetUrl.toString(),
          "",
          `This link expires at ${input.expiresAt.toISOString()}.`,
          "If you did not request this reset, you can ignore this email.",
        ].join("\n"),
      });
      return { status: "delivered" };
    } catch (error) {
      this.options.logger.error(
        {
          event: "identity.password_reset_email.delivery_failed",
          deliveryError: safeDeliveryError(error),
        },
        "Password-reset email delivery failed",
      );
      return { status: "failed" };
    }
  }
}
