import pino, { type Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));

vi.mock("nodemailer", () => ({
  createTransport: () => ({ sendMail }),
}));

import { SmtpVerificationEmailDelivery } from "../src/modules/identity/infrastructure/delivery/smtp-verification-email-delivery.js";
import { SmtpPasswordResetEmailDelivery } from "../src/modules/identity/infrastructure/delivery/smtp-password-reset-email-delivery.js";

function createDelivery(): {
  readonly delivery: SmtpVerificationEmailDelivery;
  readonly logger: Logger;
} {
  const logger = pino({ enabled: false });

  return {
    delivery: new SmtpVerificationEmailDelivery({
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      requireTls: false,
      from: "Atlas Exchange <no-reply@atlas.local>",
      webOrigin: "http://localhost:5173",
      logger,
    }),
    logger,
  };
}

const message = {
  recipientEmail: "User@Example.com",
  credential: "token-id.raw-secret",
  expiresAt: new Date("2026-08-22T12:00:00.000Z"),
};

describe("SmtpVerificationEmailDelivery", () => {
  beforeEach(() => {
    sendMail.mockReset();
  });

  it("sends a fragment-based verification link without placing the token in the query", async () => {
    sendMail.mockResolvedValue({ messageId: "mailpit-message" });
    const { delivery } = createDelivery();

    await expect(delivery.deliver(message)).resolves.toEqual({ status: "delivered" });

    const mail = sendMail.mock.calls[0]?.[0] as { text?: string } | undefined;
    expect(mail?.text).toContain("http://localhost:5173/verify-email#token=token-id.raw-secret");
    expect(mail?.text).not.toContain("?token=");
  });

  it("returns a safe failure result and does not log the recipient or credential", async () => {
    sendMail.mockRejectedValue(
      Object.assign(new Error("SMTP connection refused"), { code: "ECONNREFUSED" }),
    );
    const { delivery, logger } = createDelivery();
    const logError = vi.spyOn(logger, "error");

    await expect(delivery.deliver(message)).resolves.toEqual({ status: "failed" });

    expect(logError).toHaveBeenCalledOnce();
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).toContain("ECONNREFUSED");
    expect(logged).not.toContain(message.recipientEmail);
    expect(logged).not.toContain(message.credential);
  });
});

describe("SmtpPasswordResetEmailDelivery", () => {
  beforeEach(() => {
    sendMail.mockReset();
  });

  function createPasswordResetDelivery(): {
    readonly delivery: SmtpPasswordResetEmailDelivery;
    readonly logger: Logger;
  } {
    const logger = pino({ enabled: false });
    return {
      delivery: new SmtpPasswordResetEmailDelivery({
        host: "127.0.0.1",
        port: 1025,
        secure: false,
        requireTls: false,
        from: "Atlas Exchange <no-reply@atlas.local>",
        webOrigin: "http://localhost:5173",
        logger,
      }),
      logger,
    };
  }

  it("sends a fragment-based reset link without placing the token in the query", async () => {
    sendMail.mockResolvedValue({ messageId: "mailpit-reset-message" });
    const { delivery } = createPasswordResetDelivery();

    await expect(delivery.deliver(message)).resolves.toEqual({ status: "delivered" });

    const mail = sendMail.mock.calls[0]?.[0] as { text?: string } | undefined;
    expect(mail?.text).toContain("http://localhost:5173/reset-password#token=token-id.raw-secret");
    expect(mail?.text).not.toContain("?token=");
  });

  it("returns a safe failure without logging the recipient or credential", async () => {
    sendMail.mockRejectedValue(
      Object.assign(new Error("SMTP connection refused"), { code: "ECONNREFUSED" }),
    );
    const { delivery, logger } = createPasswordResetDelivery();
    const logError = vi.spyOn(logger, "error");

    await expect(delivery.deliver(message)).resolves.toEqual({ status: "failed" });

    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).toContain("ECONNREFUSED");
    expect(logged).not.toContain(message.recipientEmail);
    expect(logged).not.toContain(message.credential);
  });
});
