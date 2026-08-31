# Atlas Product-Scope Approval Runbook

**Classification:** Canonical

**Status:** Active

**Last reviewed:** 2026-08-31

This runbook implements ADR-073. It prepares one release-bound approval record; it does not provide
legal advice, approve the current release, create policies or support channels, or authorize traffic.

## Current state

```text
Scope validator:                    implemented and repository-tested
Invited-only Access design:         accepted; not activated
Deployed release/config evidence:   not available
Deployed disclosure review:         not performed
Privacy/data-handling approval:     not available
Tested support path:                not available
product-scope-approval control:      blocked
```

## Prepare the review

1. Start from [the blocked documentation example](product-scope-approval.example.json) in a new
   restricted file outside Git.
2. Record the exact environment, stable release version, and full source revision.
3. Identify accountable product, privacy/data-handling, support, and final approval owners.
4. Index source and deployment evidence without embedding private content in the record.
5. Keep every incomplete item `blocked`; do not copy example fields into an approval.

The approval is limited to invited testers behind deny-by-default access. Stop and create a new
decision if the intended audience is public or the product accepts real assets, routes externally,
supports payments/transfers, promises returns, or provides advice.

## Verify deployed capabilities

For the exact candidate, prove:

- `SIMULATED_FUNDING_ENABLED=false` in the effective API environment;
- `SIMULATED_WITHDRAWALS_ENABLED=false` in the effective API environment;
- no real-custody provider, address-generation, signing, blockchain broadcast, or custody webhook;
- no broker, exchange, market-maker, or external order-routing integration;
- no fiat payment, bank, card, payout, or money-transmission integration; and
- no user-to-user or externally redeemable transferable-value capability.

Review source, runtime dependencies, routes, configuration, provider resources, and the deployed
release. Do not place environment dumps, credentials, provider tokens, or private configuration in
the approval record. Use sanitized evidence references.

## Review the deployed experience

Use an invited non-admin account against the exact protected candidate. Confirm that simulation is
prominent on access, trading, funding, withdrawal, portfolio, and relevant notification surfaces.
Confirm the interface does not imply real assets, external fills, investment returns, or advice.
Confirm support and privacy paths are visible and usable.

Repository source and screenshots from another release are supporting context, not deployed-release
evidence. Store controlled screenshots externally when needed; never include credentials, cookies,
personal account details, balances, orders, or raw support messages.

## Review data handling

Review all four declared categories:

- account email;
- credential and session security data;
- operational security metadata; and
- simulation activity.

Record an accountable owner and controlled references for the actual privacy notice, retention
policy, deletion procedure, and subprocessor review. Consider the selected hosts, telemetry system,
email delivery, DNS/access provider, backup locations, support tooling, geography, and access roles.
Escalate jurisdiction- or audience-specific questions to qualified review; this runbook is not a
substitute.

## Test support

From the invited-user path, send a clearly labeled test message containing no private data. Verify it
reaches the named support owner and can follow the incident escalation path. Retain delivery and
receipt evidence. Do not mark `tested: true` merely because a contact address exists.

## Decide and validate

The accountable owner records `approved` only when every item is supported by current evidence. Run:

```bash
pnpm product:scope:validate -- /restricted/path/product-scope-approval.json
```

Require `outcome: approved`, `blockingItems: 0`, and `readinessEligible: true`. A successful command
for a blocked or expired record validates its structure only.

For ADR-066's `product-scope-approval` control, reference the restricted approval and evidence index,
and copy the validator's `observedAt` and `expiresAt`. Then validate the complete readiness record:

```bash
pnpm readiness:validate -- /restricted/path/production-readiness-record.json
```

The final decision-maker inspects the source evidence and confirms it belongs to the exact release.
If any claim cannot be verified, keep the scope control blocked.

## Stop conditions

Stop approval when access is broader than invited testers; either simulation mutation flag is on in
steady state; an external custody, execution, payment, or transfer path exists; copy is ambiguous;
required data policy or ownership is missing; support does not reach its owner; evidence contains
private material; or the release differs from the record.

Changing a blocked field to approved is never remediation by itself. Correct the system or review
gap, collect new evidence, and issue a new approval rather than rewriting an earlier decision.
