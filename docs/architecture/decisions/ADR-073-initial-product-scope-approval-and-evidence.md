# ADR-073 — Initial Product-Scope Approval and Evidence

**Classification:** Canonical

**Status:** Accepted

**Date:** 2026-08-31

**Last reviewed:** 2026-08-31

**Canonical owner/source:** ADR-073

## Context

ADR-066 requires explicit product-scope approval before production-like traffic. Atlas is a
centralized-exchange learning platform with simulated balances, deposits, withdrawals, orders, and
trades. Its technical resemblance to an exchange makes an ambiguous launch especially dangerous:
users could infer real asset custody, external market execution, transferable value, investment
returns, financial advice, or a support/privacy commitment that Atlas does not provide.

The repository already defaults simulated funding and withdrawal creation off in managed
environments, and the Render staging contract fixes both settings to `false`. Those controls alone
do not prove the deployed release has no external integrations, that product copy is truthful, that
data handling was reviewed, or that a user can reach an accountable support owner.

This decision defines the evidence contract. It does not approve the current product, supply legal
or regulatory review, create public policies, or authorize traffic.

## Decision Drivers

The product-scope boundary should:

1. make the initial permitted audience and value model exact;
2. require evidence that prohibited capabilities are absent or disabled;
3. keep simulation status prominent in the deployed user experience;
4. identify the actual personal and operational data Atlas handles;
5. require owned privacy, retention, deletion, and subprocessor reviews;
6. require a tested support and incident-escalation path;
7. bind approval to one release and expire it after ADR-066's 30-day maximum;
8. preserve a useful blocked decision without treating schema validity as approval; and
9. prevent secrets or private records from entering the approval artifact or console output.

# Decision

Atlas adopts a **structured initial product-scope approval** validated with:

```bash
pnpm product:scope:validate -- <product-scope-approval.json>
```

The approval record belongs in a restricted evidence store outside Git. The committed example is
deliberately blocked and is documentation only.

## 1. Initial permitted scope

The only scope this ADR can approve is:

```text
Purpose:       centralized-exchange learning platform
Audience:      explicitly invited testers
Access:        deny by default
Value:         simulated only
Real assets:   not accepted
Returns:       not promised
Advice:        not provided
```

Cloudflare admission and Atlas authentication remain separate controls. An invitation permits
access to the learning environment; it does not create a customer, investor, account holder,
beneficiary, or claim on an asset.

Public access, real custody, external execution, fiat payments, user-to-user transferable value,
financial advice, promised returns, or a materially broader audience requires a new architectural,
security, privacy, operational, and applicable legal review. Such expansion cannot be authorized by
changing a field in an evidence record.

## 2. Deployment controls

Every approval contains exactly these release-bound checks:

| Control | Required state |
|---|---|
| Simulated funding creation | `SIMULATED_FUNDING_ENABLED=false` |
| Simulated withdrawal creation | `SIMULATED_WITHDRAWALS_ENABLED=false` |
| Real custody | capability absent |
| External market execution | capability absent |
| Fiat payments | capability absent |
| Transferable value | capability absent |

Disabling simulated funding and withdrawals for shared staging prevents invited users from creating
arbitrary value while the operator is collecting readiness evidence. Read-only historical behavior
does not become real custody. Deliberately enabling those simulation commands for a bounded test
requires separate time-limited approval and restoration evidence; it is not the approved steady
state.

An `absent` claim requires source, dependency, configuration, route, and deployed-release review
appropriate to that capability. The validator checks that a reference exists; the accountable
reviewer checks that it proves the claim.

## 3. Product disclosures

The deployed experience is reviewed for five requirements:

- simulation is prominent rather than hidden in fine print;
- no interface represents balances or transfers as real assets;
- no interface claims orders reach an external venue;
- no interface presents Atlas output as financial advice; and
- support and privacy paths are visible to the invited audience.

Each review names an owner and source evidence. A repository README alone cannot prove deployed
copy. A disclaimer does not make an implemented real-money capability safe or authorized.

## 4. Data handling

The initial review explicitly covers account email, credential/session security data, operational
security metadata, and simulation activity. Approval requires an accountable owner and references
for the privacy notice, retention policy, deletion procedure, and subprocessor review.

This is a product and engineering approval boundary, not a legal conclusion. The owner must obtain
jurisdiction-, audience-, and provider-specific review when applicable. The record must not claim
that data is anonymous merely because balances and trades are simulated; account and operational
data can still identify a person.

## 5. Support and escalation

Approval requires one named support owner, a user-visible contact path, an incident-escalation path,
and evidence that the contact path reached the responsible operator. Atlas does not claim 24/7
coverage, a response-time guarantee, public status page, or legally complete notification process.
The actual offered coverage must be communicated truthfully outside this record.

An address, form, or ticket queue that was not tested is not an approved support path. Sensitive
account or security reports must move to an access-controlled channel rather than being copied into
the scope record.

## 6. Decision, evidence, and freshness

The record binds the decision to a stable version and full source revision. `approved` is permitted
only when every deployment control is verified, every disclosure is approved, data handling is
approved, the support path is approved and tested, evidence contains no placeholders, and the
revision is not the example value.

A `blocked` decision must expose at least one blocked item. It is structurally valid and useful but
never readiness-eligible. An approved decision remains eligible for 30 days from `decidedAt`; the
validator emits that time as `observedAt` and the exact expiry for the ADR-066 record.

The validator proves shape, required coverage, internal consistency, basic secret rejection, and
freshness. It cannot prove that deployed settings match evidence, a reviewer is authorized, a
policy is adequate, or a capability is absent. The accountable readiness decision-maker must
inspect the restricted evidence.

## 7. Sensitive-data boundary

The approval may contain role/owner aliases, sanitized notes, opaque evidence references, release
identity, and decisions. It must not contain credentials, cookies, database URLs, private keys, raw
logs, private account records, attributable financial values, support-message contents, or provider
secret values. Detailed source artifacts stay in the restricted evidence store.

## Alternatives Considered

### Treat “learning platform” in the README as approval

Rejected because source copy does not verify deployment configuration, visible UI claims, data
handling, support reachability, or the exact release.

### Allow public self-service access initially

Rejected because the current support, privacy, abuse, operational, and jurisdiction boundaries have
not been approved for an unbounded audience.

### Enable simulated funding for shared staging by default

Rejected because persistent shared state would be trivial to inflate and could be mistaken for an
approved product behavior. Bounded tests can enable it only under separate reviewed controls.

### Make the validator grant approval automatically

Rejected because product truth, policy adequacy, evidence authenticity, and accountable authority
require human judgment.

### Claim simulated account data is not personal data

Rejected because email, session/security metadata, network metadata, and activity can identify or
relate to a person even when value is fictional.

## Consequences

### Positive Consequences

- The first permitted audience and capability boundary are unambiguous.
- Real-money and external-execution implications fail closed.
- Product, privacy, support, and deployment evidence meet in one reviewable decision.
- Blocked reviews remain visible instead of becoming implied approval.
- Approval is release-bound, short-lived, and safe to summarize in logs.

### Negative Consequences

- External policies, owners, and contact paths still require real work outside the repository.
- Absence claims require human review and cannot be fully proven by the validator.
- The invited-only boundary prevents a public launch without a later decision.
- Approval must be repeated when the scope, release, evidence, or 30-day window changes.

## Reconsider When

Review this decision before public registration, public marketing, any real-asset integration,
external order routing, payments, transferable value, advice or recommendation features, additional
jurisdictions, materially new data categories, new subprocessors, or staffed support commitments.

## Related Decisions

- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-022 — Simulated Deposit Lifecycle and Custody Boundary](ADR-022-simulated-deposit-lifecycle-and-custody-boundary.md)
- [ADR-024 — Simulated Withdrawal Lifecycle and Custody Boundary](ADR-024-simulated-withdrawal-lifecycle-and-custody-boundary.md)
- [ADR-055 — Light Product Interface and Visual System](ADR-055-light-product-interface-and-visual-system.md)
- [ADR-066 — Operational Readiness, Incident Response, and Production Go/No-Go](ADR-066-operational-readiness-incident-response-and-production-go-no-go.md)
- [ADR-068 — Staging Domain and Access-Control Boundary](ADR-068-staging-domain-and-access-control-boundary.md)
