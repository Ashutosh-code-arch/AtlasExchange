import { argon2id, hash } from "argon2";
import { describe, expect, it } from "vitest";

import {
  Argon2PasswordHasher,
  atlasArgon2Parameters,
} from "../src/modules/identity/infrastructure/security/argon2-password-hasher.js";

const password = "correct horse battery staple";

describe("Argon2PasswordHasher", () => {
  const passwordHasher = new Argon2PasswordHasher();

  it("creates an Argon2id PHC hash with the approved parameters", async () => {
    const encodedHash = await passwordHasher.hash(password);

    expect(encodedHash).toMatch(/^\$argon2id\$v=19\$/);
    expect(encodedHash.split(String.fromCodePoint(36))[3]?.split(",").sort()).toEqual([
      "m=65536",
      "p=1",
      "t=3",
    ]);
    expect(encodedHash).not.toContain(password);
    await expect(passwordHasher.verify(password, encodedHash)).resolves.toBe(true);
  });

  it("uses a unique random salt for every hash", async () => {
    const firstHash = await passwordHasher.hash(password);
    const secondHash = await passwordHasher.hash(password);

    expect(firstHash).not.toBe(secondHash);
    await expect(passwordHasher.verify(password, firstHash)).resolves.toBe(true);
    await expect(passwordHasher.verify(password, secondHash)).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const encodedHash = await passwordHasher.hash(password);

    await expect(passwordHasher.verify("incorrect password", encodedHash)).resolves.toBe(false);
  });

  it("identifies hashes that use obsolete parameters", async () => {
    const currentHash = await passwordHasher.hash(password);
    const obsoleteHash = await hash(password, {
      type: argon2id,
      version: 0x13,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32,
    });

    expect(passwordHasher.needsRehash(currentHash)).toBe(false);
    expect(passwordHasher.needsRehash(obsoleteHash)).toBe(true);
    expect(atlasArgon2Parameters).toMatchObject({
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
      hashLength: 32,
    });
  });

  it("surfaces malformed stored hashes as persistence or operational failures", async () => {
    await expect(passwordHasher.verify(password, "not-a-phc-hash")).rejects.toThrow();
    expect(() => passwordHasher.needsRehash("not-a-phc-hash")).toThrow();
  });
});
