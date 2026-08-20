import { randomBytes } from "node:crypto";

import { argon2id, hash, needsRehash, verify } from "argon2";

import type { PasswordHasher } from "../../application/password-hasher.js";

export const atlasArgon2Parameters = Object.freeze({
  type: argon2id,
  version: 0x13,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
});

const saltLengthBytes = 16;

export class Argon2PasswordHasher implements PasswordHasher {
  public async hash(password: string): Promise<string> {
    return hash(password, {
      ...atlasArgon2Parameters,
      salt: randomBytes(saltLengthBytes),
    });
  }

  public async verify(password: string, encodedHash: string): Promise<boolean> {
    return verify(encodedHash, password);
  }

  public needsRehash(encodedHash: string): boolean {
    return needsRehash(encodedHash, atlasArgon2Parameters);
  }
}
