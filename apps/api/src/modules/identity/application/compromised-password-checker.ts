import type { NormalizedPassword } from "../domain/password.js";

export interface CompromisedPasswordChecker {
  isCompromised(password: NormalizedPassword): Promise<boolean>;
}
