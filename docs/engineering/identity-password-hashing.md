# Identity Password Hashing Baseline

**Classification:** Canonical  
**Status:** Active  
**Last reviewed:** 2026-08-21
**Canonical owner/source:** ADR-017

## Purpose

This document records the benchmark and implementation parameters required by ADR-017 before Atlas password hashing is implemented.

## Approved development baseline

Atlas uses `node-argon2` with:

```text
Algorithm:       Argon2id
Version:         19 (0x13)
Memory cost:     65,536 KiB (64 MiB)
Time cost:       3 iterations
Parallelism:     1 lane
Salt length:     16 bytes, cryptographically random per password
Hash length:     32 bytes
Storage format:  PHC string
```

The encoded PHC string stores the algorithm, version, work factors, salt, and hash. Raw passwords and salts are not stored separately.

Atlas does not introduce a password pepper in this baseline. A pepper requires a production secret lifecycle, rotation, recovery, and availability design; it must not be improvised inside application configuration.

## Benchmark method

Run:

```bash
pnpm --filter @atlas/api benchmark:password
```

The harness performs one warm-up operation and seven measured hashes per candidate using a realistic fixed-length benchmark input and a fresh random salt for each measured hash.

Development benchmark environment:

```text
Machine class:   Apple M4 development laptop
Memory:          16 GiB
Architecture:    arm64
Node.js:         24.7.0
Samples:         7 per candidate
```

Results recorded on 2026-08-20:

| Memory | Iterations | Parallelism | Median | p95 |
|---:|---:|---:|---:|---:|
| 19 MiB | 2 | 1 | 15.0 ms | 16.3 ms |
| 32 MiB | 3 | 1 | 43.0 ms | 44.6 ms |
| 64 MiB | 3 | 1 | 88.5 ms | 93.2 ms |

## Selection rationale

The selected `64 MiB / 3 / 1` profile:

- exceeds the OWASP minimum `19 MiB / 2 / 1` profile;
- uses the memory and iteration costs from RFC 9106's second recommended profile;
- keeps one lane to limit per-request thread pressure and preserve predictable API concurrency;
- remains below 100 ms at p95 on the development environment;
- produces a self-describing PHC string that supports future rehash-on-login upgrades.

Each concurrent hash may consume approximately 64 MiB. Authentication rate limits and bounded concurrency remain required defenses against resource exhaustion.

## Production gate

This benchmark validates development feasibility; it is not production capacity evidence. Before the first production deployment, rerun the harness on the selected production compute class and test realistic concurrent login/registration load.

Reconsider the parameters when:

- production p95 hashing latency materially exceeds the authentication latency budget;
- concurrent hashing exceeds the memory or worker-thread budget;
- production hardware permits a stronger work factor;
- OWASP or RFC guidance changes;
- the Argon2 implementation or Node.js runtime changes materially.

Existing hashes are verified using their encoded PHC parameters. A successful login should rehash the password when the stored parameters no longer match the approved baseline.

## Compromised-password blocklist

Atlas performs compromised-password checks locally before Argon2 hashing. Runtime code never sends
passwords or password-derived lookup values to an external service.

The runtime blocklist format is:

```text
one lowercase or uppercase SHA-256 hexadecimal digest per line
blank lines ignored
lines beginning with # ignored
```

Passwords are NFC-normalized before their UTF-8 SHA-256 digest is calculated. Only digests remain
resident in the checker. A missing, malformed, or empty configured file prevents Identity module
startup.

The committed `resources/development-password-blocklist.sha256` file is only a deterministic local
and test baseline. It is not production security evidence. Staging and production must explicitly
set `PASSWORD_BLOCKLIST_PATH` to a managed digest file prepared offline from an approved, curated
source. Raw source passwords must not be committed to Atlas.

Before production, record the source, source version/date, preparation method, entry count, and
artifact checksum, then test startup memory and lookup latency with the deployed artifact.

## Sources

- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [RFC 9106 — Argon2](https://www.rfc-editor.org/rfc/rfc9106.html)
- [node-argon2](https://github.com/ranisalt/node-argon2)
