import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { CompromisedPasswordChecker } from "../../application/compromised-password-checker.js";
import type { NormalizedPassword } from "../../domain/password.js";

const sha256DigestPattern = /^[a-fA-F0-9]{64}$/;

export class PasswordBlocklistFormatError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PasswordBlocklistFormatError";
  }
}

export class LocalCompromisedPasswordChecker implements CompromisedPasswordChecker {
  private readonly compromisedPasswordDigests: ReadonlySet<string>;

  private constructor(digests: Iterable<string>) {
    this.compromisedPasswordDigests = new Set(
      Array.from(digests, (digest) => digest.toLowerCase()),
    );
  }

  public static fromPasswords(passwords: Iterable<string>): LocalCompromisedPasswordChecker {
    return new LocalCompromisedPasswordChecker(
      Array.from(passwords, (password) =>
        createHash("sha256").update(password.normalize("NFC"), "utf8").digest("hex"),
      ),
    );
  }

  public static fromSha256Digests(digests: Iterable<string>): LocalCompromisedPasswordChecker {
    const validatedDigests: string[] = [];
    let lineNumber = 0;
    for (const digest of digests) {
      lineNumber += 1;
      if (!sha256DigestPattern.test(digest)) {
        throw new PasswordBlocklistFormatError(
          `Invalid password blocklist digest on line ${lineNumber}.`,
        );
      }
      validatedDigests.push(digest);
    }
    if (validatedDigests.length === 0) {
      throw new PasswordBlocklistFormatError(
        "Password blocklist must contain at least one digest.",
      );
    }
    return new LocalCompromisedPasswordChecker(validatedDigests);
  }

  public static async fromFile(filePath: string): Promise<LocalCompromisedPasswordChecker> {
    const contents = await readFile(filePath, "utf8");
    const digests: string[] = [];
    for (const [index, sourceLine] of contents.split(/\r?\n/u).entries()) {
      const digest = sourceLine.trim();
      if (digest.length === 0 || digest.startsWith("#")) {
        continue;
      }
      if (!sha256DigestPattern.test(digest)) {
        throw new PasswordBlocklistFormatError(
          `Invalid password blocklist digest on line ${index + 1}.`,
        );
      }
      digests.push(digest);
    }

    return LocalCompromisedPasswordChecker.fromSha256Digests(digests);
  }

  public isCompromised(password: NormalizedPassword): Promise<boolean> {
    const digest = createHash("sha256").update(password, "utf8").digest("hex");
    return Promise.resolve(this.compromisedPasswordDigests.has(digest));
  }
}
