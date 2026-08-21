import type { NormalizedEmail } from "../domain/email-address.js";
import type { IdentityAccountState } from "../domain/account-state.js";

export interface PasswordAccount {
  readonly userId: string;
  readonly displayEmail: string;
  readonly state: IdentityAccountState;
  readonly passwordHash: string;
}

export interface PasswordAccountReader {
  findByNormalizedEmail(normalizedEmail: NormalizedEmail): Promise<PasswordAccount | undefined>;
}
