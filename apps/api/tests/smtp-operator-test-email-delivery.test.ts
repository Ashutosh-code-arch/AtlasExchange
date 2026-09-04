import { beforeEach, describe, expect, it, vi } from "vitest";
const { sendMail, close, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  const close = vi.fn();
  return { sendMail, close, createTransport: vi.fn(() => ({ sendMail, close })) };
});
vi.mock("nodemailer", () => ({ createTransport }));
import { SmtpOperatorTestEmailDelivery } from "../src/modules/identity/infrastructure/delivery/smtp-operator-test-email-delivery.js";

const options = {
  host: "smtp.example.com",
  port: 2525,
  secure: false,
  requireTls: true,
  from: "Atlas <sender@example.com>",
  username: "login",
  password: "smtp-secret",
};
describe("operator SMTP adapter", () => {
  beforeEach(() => {
    sendMail.mockReset();
    close.mockClear();
    createTransport.mockClear();
  });
  it("requires TLS, bounds timeouts, and sends fixed content to exactly one mailbox", async () => {
    const delivery = new SmtpOperatorTestEmailDelivery(options);
    sendMail.mockResolvedValue({ accepted: ["operator@example.com"], rejected: [] });
    expect(await delivery.deliver("Operator@example.com")).toBe("accepted");
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        requireTLS: true,
        secure: false,
        connectionTimeout: 5000,
        socketTimeout: 10000,
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { name: "", address: "Operator@example.com" },
        from: options.from,
        subject: "Atlas Exchange operator email test",
      }),
    );
    expect(JSON.stringify(sendMail.mock.calls)).not.toMatch(/smtp-secret|https?:|#token/);
    expect(close).toHaveBeenCalledOnce();
  });
  it("refuses lists and header injection before making a request", async () => {
    const delivery = new SmtpOperatorTestEmailDelivery(options);
    for (const recipient of [
      "a@example.com,b@example.com",
      "Name <a@example.com>",
      "a@example.com\r\nBcc: b@example.com",
      "invalid",
    ])
      expect(await delivery.deliver(recipient)).toBe("failed");
    expect(sendMail).not.toHaveBeenCalled();
  });
  it("requires explicit SMTP acceptance, not just a resolved promise", async () => {
    const delivery = new SmtpOperatorTestEmailDelivery(options);
    for (const result of [
      { accepted: [], rejected: ["operator@example.com"] },
      { accepted: ["other@example.com"], rejected: [] },
      {},
    ]) {
      sendMail.mockResolvedValue(result);
      expect(await delivery.deliver("operator@example.com")).toBe("failed");
    }
    sendMail.mockRejectedValue(new Error("535 smtp-secret operator@example.com"));
    expect(await delivery.deliver("operator@example.com")).toBe("failed");
    expect(close).toHaveBeenCalledTimes(4);
  });
});
