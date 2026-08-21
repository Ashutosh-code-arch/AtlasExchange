import type { CompromisedPasswordChecker } from "../../application/compromised-password-checker.js";
import type { NormalizedPassword } from "../../domain/password.js";

export class LocalCompromisedPasswordChecker implements CompromisedPasswordChecker {
  private readonly compromisedPasswords: ReadonlySet<string>;

  public constructor(entries: Iterable<string>) {
    this.compromisedPasswords = new Set(
      Array.from(entries, (entry) => entry.normalize("NFC")).filter((entry) => entry.length > 0),
    );
  }

  public isCompromised(password: NormalizedPassword): Promise<boolean> {
    return Promise.resolve(this.compromisedPasswords.has(password));
  }
}
