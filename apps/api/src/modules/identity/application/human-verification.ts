export type HumanVerificationAction = "register" | "resend_verification" | "forgot_password";

export type HumanVerificationResult = "verified" | "rejected" | "unavailable";

export interface HumanVerification {
  verify(
    input: Readonly<{
      token: string | undefined;
      remoteIp: string;
      action: HumanVerificationAction;
    }>,
  ): Promise<HumanVerificationResult>;
}
