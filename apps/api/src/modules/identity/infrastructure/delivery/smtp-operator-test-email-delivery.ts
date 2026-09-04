import * as nodemailer from "nodemailer";
import { z } from "zod";

import type { OperatorTestEmailDelivery } from "../../application/send-operator-test-email.js";
import type { SmtpVerificationEmailDeliveryOptions } from "./smtp-verification-email-delivery.js";

export class SmtpOperatorTestEmailDelivery implements OperatorTestEmailDelivery {
  private readonly transporter;

  public constructor(
    private readonly options: Omit<SmtpVerificationEmailDeliveryOptions, "webOrigin" | "logger">,
  ) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      requireTLS: true,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      ...(options.username === undefined || options.password === undefined
        ? {}
        : {
            auth: { user: options.username, pass: options.password },
          }),
    });
  }

  public async deliver(recipientEmail: string): Promise<"accepted" | "failed"> {
    // A single mailbox only: never accept address lists, display-name syntax, or header injection.
    if (!z.email().safeParse(recipientEmail).success) return "failed";
    try {
      const result = await this.transporter.sendMail({
        from: this.options.from,
        to: { name: "", address: recipientEmail },
        subject: "Atlas Exchange operator email test",
        text: "You requested this email from your Atlas Exchange Profile page.\n\nThis tests email delivery only. It does not verify an account, reset a password, or enable public signup. No action or link is required.\n\nIf this reached your inbox, confirm receipt in your operator checklist.",
      });
      return result.accepted.some(
        (address) =>
          typeof address === "string" && address.toLowerCase() === recipientEmail.toLowerCase(),
      ) && result.rejected.length === 0
        ? "accepted"
        : "failed";
    } catch {
      return "failed";
    } finally {
      this.transporter.close();
    }
  }
}
