export interface VerificationSecret {
  readonly secret: string;
  readonly digest: Uint8Array;
}

export interface VerificationSecretGenerator {
  generate(): VerificationSecret;
}
