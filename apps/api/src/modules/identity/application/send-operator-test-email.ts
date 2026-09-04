import type { AuthenticatedContext } from "./authenticated-context.js";
import type { RegistrationRateLimiter } from "./registration-rate-limiter.js";

export interface OperatorTestEmailDelivery {
  deliver(recipientEmail: string): Promise<"accepted" | "failed">;
}

export type OperatorTestEmailResult =
  | { readonly status: "forbidden" | "accepted" | "failed" }
  | { readonly status: "rate_limited"; readonly retryAfterSeconds: number };

export class SendOperatorTestEmail {
  private sending = false;

  public constructor(
    private readonly options: {
      readonly operatorUserId: string;
      readonly delivery: OperatorTestEmailDelivery;
      readonly rateLimiter: RegistrationRateLimiter;
    },
  ) {}

  public isAvailable(context: AuthenticatedContext): boolean {
    return context.userId === this.options.operatorUserId;
  }

  // The recipient is supplied exclusively by server-side session authentication.
  public async execute(
    context: AuthenticatedContext,
    authenticatedEmail: string,
  ): Promise<OperatorTestEmailResult> {
    if (!this.isAvailable(context)) return { status: "forbidden" };
    if (this.sending) return { status: "rate_limited", retryAfterSeconds: 15 };
    const decision = this.options.rateLimiter.consume(context.userId);
    if (!decision.allowed)
      return { status: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds };
    this.sending = true;
    try {
      return { status: await this.options.delivery.deliver(authenticatedEmail) };
    } catch {
      // SMTP responses can contain addresses, credentials, or untrusted provider text.
      return { status: "failed" };
    } finally {
      this.sending = false;
    }
  }
}
