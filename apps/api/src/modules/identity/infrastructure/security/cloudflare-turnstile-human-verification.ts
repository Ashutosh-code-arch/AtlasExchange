import { z } from "zod";

import type {
  HumanVerification,
  HumanVerificationResult,
} from "../../application/human-verification.js";

const siteverifyResponseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
  "error-codes": z.array(z.string()).optional(),
});

type Fetch = typeof fetch;

export interface CloudflareTurnstileHumanVerificationOptions {
  readonly secretKey: string;
  readonly expectedHostname: string;
  readonly timeoutMilliseconds?: number;
  readonly fetch?: Fetch;
}

export class CloudflareTurnstileHumanVerification implements HumanVerification {
  private readonly secretKey: string;
  private readonly expectedHostname: string;
  private readonly timeoutMilliseconds: number;
  private readonly fetch: Fetch;

  public constructor(options: CloudflareTurnstileHumanVerificationOptions) {
    this.secretKey = options.secretKey;
    this.expectedHostname = options.expectedHostname;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 5_000;
    this.fetch = options.fetch ?? globalThis.fetch;

    if (
      this.secretKey.length === 0 ||
      this.expectedHostname.length === 0 ||
      this.timeoutMilliseconds < 100 ||
      this.timeoutMilliseconds > 30_000
    ) {
      throw new RangeError("Turnstile human-verification configuration is invalid.");
    }
  }

  public async verify(
    input: Parameters<HumanVerification["verify"]>[0],
  ): Promise<HumanVerificationResult> {
    if (input.token === undefined || input.token.length === 0 || input.token.length > 2_048) {
      return "rejected";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    try {
      const response = await this.fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            secret: this.secretKey,
            response: input.token,
            remoteip: input.remoteIp,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        return "unavailable";
      }

      const parsedResponse = siteverifyResponseSchema.safeParse(await response.json());
      if (!parsedResponse.success) {
        return "unavailable";
      }
      if (!parsedResponse.data.success) {
        return parsedResponse.data["error-codes"]?.includes("internal-error") === true
          ? "unavailable"
          : "rejected";
      }
      return parsedResponse.data.hostname === this.expectedHostname &&
        parsedResponse.data.action === input.action
        ? "verified"
        : "rejected";
    } catch {
      return "unavailable";
    } finally {
      clearTimeout(timeout);
    }
  }
}
