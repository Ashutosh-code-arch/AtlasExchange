export interface OpaqueCredential {
  readonly secret: string;
  readonly digest: Uint8Array;
}

export interface OpaqueCredentialGenerator {
  generate(): OpaqueCredential;
}
