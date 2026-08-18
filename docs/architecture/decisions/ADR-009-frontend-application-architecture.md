# ADR-009: Frontend Application Architecture

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-17  
**Last reviewed:** 2026-08-17  
**Canonical owner/source:** ADR-009

## Context

Atlas's frontend will eventually present:

- authentication and account management;
- markets and real-time prices;
- order entry and order books;
- balances and transaction history;
- open orders and trade history;
- administrative capabilities.

A repository-wide technical structure such as:

```text
components/
hooks/
services/
stores/
utils/
```

becomes difficult to maintain as the application grows. Technical categories remain visible, while ownership of the business capability they support becomes unclear.

The frontend architecture must make it possible to answer:

- Which feature owns this behavior?
- Where does server communication belong?
- Which state is authoritative?
- Which components are genuinely reusable?
- May one feature import another feature's internal hooks or components?
- Where are API contracts converted into UI-friendly models?

Atlas's backend remains authoritative for:

- balances;
- ledger entries;
- order status;
- trades;
- fees;
- permissions;
- financial validation.

Frontend validation exists for usability and feedback only. It is never a financial or security control.

For financially important operations, the frontend must not represent an operation as successful before the server confirms it. Optimistic interaction may be used for harmless presentation state, but must be used cautiously for orders, balances, and other authoritative financial state.

## Decision Drivers

The frontend architecture should:

1. organize business behavior by user-facing capability;
2. make feature ownership visible;
3. keep application-wide composition separate from feature behavior;
4. keep route composition relatively thin;
5. keep genuinely reusable code separate from feature-specific code;
6. distinguish local, form, URL, server, session, and derived state;
7. keep generic transport separate from feature-owned API operations;
8. keep `@atlas/contracts` limited to shared transport contracts;
9. validate untrusted network data at the appropriate external boundary;
10. prevent uncontrolled feature-to-feature coupling and dependency cycles;
11. preserve backend authority over financial and security decisions;
12. avoid unnecessary frontend architectural ceremony;
13. defer selection of state-management, query-cache, form, and routing libraries.

# Decision

Atlas will use a **pragmatic feature-first frontend architecture**.

Business behavior is organized by user-facing capability, while application composition, route composition, and genuinely reusable primitives remain separate.

The illustrative structure is:

```text
apps/web/src/
├── app/
│   ├── router/
│   ├── providers/
│   ├── configuration/
│   └── bootstrap/
│
├── pages/
│   ├── login/
│   ├── markets/
│   ├── trading/
│   └── portfolio/
│
├── features/
│   ├── authentication/
│   ├── place-order/
│   ├── view-order-book/
│   ├── manage-open-orders/
│   └── view-balances/
│
└── shared/
    ├── ui/
    ├── api/
    ├── formatting/
    └── utilities/
```

Exact directory and file names are illustrative. The ownership and dependency rules defined below are normative.

Atlas will not adopt a strict named frontend methodology such as Feature-Sliced Design as a mandatory architectural framework. The project will use the smaller feature-first rule set defined by this ADR.

## 1. Feature-First Organization

Frontend business behavior belongs primarily to the feature that owns the user-facing capability.

Examples include:

- authentication;
- placing an order;
- cancelling an order;
- viewing an order book;
- viewing balances;
- filtering trade history.

A feature may own:

- feature-specific components;
- hooks;
- API operations;
- state transitions;
- validation;
- feature-specific UI behavior;
- its deliberately small public interface.

Features do not need to correspond one-to-one with backend modules.

For example, a trading page may compose:

```text
trading page
├── market-data capability
├── place-order capability
├── balances capability
└── open-orders capability
```

This allows the frontend to model user capabilities rather than mirroring backend implementation boundaries mechanically.

## 2. `app/`

`app/` contains application-wide composition and infrastructure.

It may contain:

- router construction;
- global providers;
- application bootstrap;
- global configuration initialization;
- global error boundaries;
- dependency composition.

It must not become a location for feature business behavior.

The application layer answers:

> How is the frontend application assembled?

It does not answer:

> How does a particular business capability behave?

## 3. `pages/`

`pages/` contains route-level composition.

Pages may:

- arrange features and page sections;
- read route parameters;
- coordinate page layout;
- define route-level loading presentation;
- define route-level error presentation.

Pages should remain relatively thin.

A page should compose capabilities rather than absorb the business implementation of those capabilities.

## 4. `features/`

`features/` contains user-facing capabilities.

A feature owns the behavior necessary to implement its capability while exposing only a small public interface for composition.

Feature internals must not be treated as application-wide reusable code.

A feature may contain its own:

```text
components/
hooks/
api/
state/
validation/
```

when those boundaries are meaningful.

Exact internal structure remains an implementation detail.

## 5. `shared/`

`shared/` contains genuinely cross-feature, domain-neutral code.

Examples include:

- design-system primitives;
- generic HTTP transport;
- generic formatting functions;
- domain-neutral utilities.

Feature-specific components, hooks, API operations, and business behavior must not be moved into `shared/` merely because two features currently use them.

`shared/` must not become a dumping ground for code whose actual ownership has not been decided.

## 6. Dependency Direction

The intended dependency direction is:

```text
app
 ↓
pages
 ↓
features
 ↓
shared
```

Lower levels must not import higher levels.

Feature internals should not be imported directly by another feature.

When one feature needs to expose behavior to another part of the application, it may expose a deliberately small public interface.

Public exports control access; they do not justify circular dependencies.

Frontend feature dependencies must remain explicit and acyclic.

This is prohibited:

```text
place-order → balances → place-order
```

When two features appear to require each other, Atlas should instead:

1. move composition to a page or higher-level application component;
2. reconsider feature ownership;
3. extract genuinely shared, domain-neutral behavior into `shared/`; or
4. use another appropriate boundary where the dependency represents an actual application-level relationship.

The preferred composition is:

```text
trading page
   ├── place-order
   └── balances
```

rather than feature internals depending on each other.

## 7. State Categories and Ownership

Frontend state is not one homogeneous category.

| State category | Example | Recommended owner |
|---|---|---|
| Local interaction state | Open dialog, selected tab | Owning component |
| Form state | Order side, price, quantity | Owning feature/form |
| Navigation state | Market symbol, filters | URL where appropriate |
| Server state | Balances, orders, markets | API/query-cache layer |
| Application session state | Authenticated user/session | Application-level provider or authentication/session capability |
| Derived state | Order estimate from price and quantity | Compute from existing state |

Atlas should default to the narrowest appropriate owner.

State must not become global merely because multiple components currently need access to it.

### Server State

Server state is authoritative data owned by the backend and represented in the browser.

Examples include:

- balances;
- orders;
- trades;
- market data;
- ledger-related information.

The frontend should treat these as server state rather than ordinary client-owned state.

A server-state/query-cache solution may be selected separately. This ADR establishes the state category and ownership rule, not the library.

### Derived State

Derived values should generally be computed from existing authoritative state rather than stored redundantly.

For example:

```text
price + quantity
      ↓
order estimate
```

should generally be derived rather than maintained as a second independent state source.

## 8. API Boundary

The frontend separates generic HTTP transport from feature-owned API operations.

The intended flow is:

```text
shared/api/http-client
             ↓
feature-owned API operation
             ↓
feature hook/component
```

For example:

```text
generic HTTP client
        ↓
features/place-order/api/placeOrder()
        ↓
features/place-order/hooks/usePlaceOrder()
        ↓
OrderEntryForm
```

The generic HTTP client owns transport concerns such as:

- base URL;
- serialization;
- credential/header attachment mechanism;
- cancellation and timeouts;
- normalized transport errors.

It does not own business operations such as placing orders or cancelling orders.

### Authentication Plumbing

Generic transport provides authentication mechanisms, while the authentication/session capability owns authentication policy and lifecycle.

The distinction is:

```text
shared/api/http-client
├── base URL
├── serialization
├── credentials/header attachment mechanism
├── cancellation/timeouts
└── normalized transport errors

authentication/session feature
├── token/session lifecycle
├── refresh coordination
├── logout behavior
└── authentication-specific recovery policy
```

The generic client may attach credentials through the mechanism established by the authentication/session capability, but it must not decide authentication policy.

## 9. Runtime Contract Validation

Static TypeScript types do not validate network data at runtime.

Feature-owned API adapters must validate untrusted response payloads at runtime where Atlas defines a runtime contract schema.

Type assertions must not substitute for validation.

The intended boundary is:

```text
HTTP response
     ↓
feature API adapter
     ↓
runtime contract validation
     ↓
UI-friendly feature model/state
     ↓
component
```

High-volume market-data streams may receive a separately justified validation and performance policy later.

Runtime validation belongs at the external trust boundary rather than being assumed from the existence of a TypeScript type.

## 10. `@atlas/contracts` Boundary

`@atlas/contracts` provides shared **transport contracts containing domain concepts**.

It is shared by the API and web applications as a definition boundary:

```text
@atlas/api ────────→ @atlas/contracts ←──────── @atlas/web

@atlas/web ───────────── HTTP ────────────────→ @atlas/api
```

The contracts package does not sit in the runtime request path. HTTP carries the actual data.

`@atlas/contracts` may contain:

- request schemas;
- response schemas;
- shared transport types;
- shared identifiers or enums that genuinely cross the API boundary;
- runtime validation schemas where the transport contract owns them.

It must not contain:

- backend domain entities;
- backend application services;
- persistence models;
- backend internal business behavior;
- React components;
- React hooks;
- UI state;
- display strings;
- CSS;
- frontend-specific view models;
- component props that have no transport/domain-contract meaning.

A transport contract may represent a domain concept without becoming the backend's internal domain model.

For example:

```text
OrderResponse
    ≠ necessarily
backend Order entity
```

The API may map its internal domain representation into the transport contract, and the frontend may map that contract into a UI-friendly model.

## 11. Backend Authority and Optimistic Updates

The backend remains authoritative for:

- balances;
- ledger entries;
- order status;
- trades;
- fees;
- permissions;
- financial validation.

Frontend validation is for usability and feedback only. It is never a financial or security control.

For financially important operations, the frontend must not optimistically represent server-authoritative success before confirmation.

For example:

```text
User clicks Place Order
        ↓
request sent
        ↓
UI = submitting/pending
        ↓
server confirms
        ↓
authoritative server state is reflected
```

The same principle applies to:

- order cancellation;
- balance changes;
- trade creation;
- other financially authoritative operations.

Optimistic interaction remains appropriate for harmless presentation state such as:

- opening or closing a panel;
- selecting a tab;
- changing local display preferences.

The principle is:

> Optimistic UI may predict presentation; it must not fabricate financial truth.

Any future optimistic strategy for financial state requires an explicit design that accounts for server confirmation, rejection, reconciliation, and stale state.

## 12. Testing and Boundary Implications

The feature-first architecture supports isolated testing of frontend behavior.

Conceptually:

```text
shared
  → test reusable primitives independently

feature
  → test feature behavior and state transitions

page
  → test route-level composition where useful

app
  → test application composition and integration behavior
```

API adapters can be tested independently of visual components.

Runtime contract validation can be tested with valid and malformed payloads.

Financially authoritative UI behavior should be tested to ensure that pending, confirmed, rejected, and stale states are represented correctly.

The exact testing levels and tooling remain governed by the testing architecture and testing toolchain decisions rather than this ADR.

# Alternatives Considered

## Alternative 1: Repository-Wide Technical Folders

```text
components/
hooks/
services/
stores/
utils/
```

### Benefits

- Simple initial structure.
- Familiar to many frontend developers.
- Easy to locate code by technical type.

### Rejected because

Feature ownership becomes obscured as the application grows.

A component may belong to trading, authentication, portfolio, or administration, but the directory structure does not communicate that ownership.

This encourages broad imports and increasingly global technical buckets.

## Alternative 2: Strict Frontend Clean Architecture

Every feature would contain formal entities, use cases, gateways, repositories, presenters, mappers, and adapters.

### Benefits

- Strong isolation.
- Explicit abstractions.
- Clear theoretical separation.

### Rejected because

The ceremony is disproportionate to Atlas's current scale and solo-development constraints.

Atlas needs explicit ownership and dependency boundaries without requiring every feature to adopt identical layers and abstractions.

## Alternative 3: Adopt Feature-Sliced Design as the Formal Methodology

### Benefits

- Established terminology and conventions.
- Stronger prescribed frontend boundaries.
- Existing ecosystem and documentation.

### Rejected because

Atlas does not currently need a full named methodology.

The smaller feature-first rule set provides the required ownership and dependency properties while leaving implementation details flexible.

A formal methodology may be reconsidered if frontend scale or team size makes its additional conventions valuable.

## Alternative 4: Treat `@atlas/contracts` as Shared Runtime Data

### Rejected because

`@atlas/contracts` is a definition boundary, not a network transport layer.

The API and web applications depend on the same contract definitions, while HTTP carries actual runtime data.

Treating the package as if it were in the request path would incorrectly couple compile-time package sharing with runtime communication.

## Alternative 5: Put Frontend Models Directly in `@atlas/contracts`

### Rejected because

Frontend display models and React-specific state are not transport contracts.

This would couple the shared package to frontend presentation concerns and encourage the backend API shape to become the frontend's internal state model.

The API transport boundary should remain explicit.

## Alternative 6: Optimistically Update Financial State

### Rejected as the default because

Orders, balances, trades, and related state are authoritative on the server.

Optimistically claiming financial success creates reconciliation and correctness problems when the server rejects, delays, or modifies the operation.

Optimistic presentation remains allowed for non-authoritative UI interactions.

# Consequences

## Positive Consequences

### Clear feature ownership

Business behavior is located with the user-facing capability that owns it.

### Controlled dependencies

Features cannot freely reach into one another's internal hooks or components.

### Appropriate state ownership

State remains close to the narrowest owner and server data is recognized as a separate category.

### Backend authority is preserved

The browser cannot become the source of truth for financial or security decisions.

### Clear transport boundary

Generic HTTP behavior remains separate from feature-owned business operations.

### Runtime validation is explicit

Untrusted network data is validated where runtime contract schemas exist.

### Contracts remain stable and technology-neutral

`@atlas/contracts` shares transport definitions without importing backend implementation details or React presentation concerns.

### Future scalability

The feature boundaries provide a reasonable path for the frontend to grow without immediately requiring micro-frontends or a formal architecture framework.

### Deferred complexity

State-management, query-cache, form, and routing libraries can be selected based on demonstrated requirements.

## Negative Consequences

### More deliberate ownership decisions

Developers must decide which feature owns a behavior rather than placing code in a convenient global technical folder.

### Feature public interfaces require discipline

Cross-feature composition requires intentionally designed exports.

### Some duplication may be appropriate

A small amount of repeated feature-specific code may be preferable to prematurely creating shared abstractions.

### Runtime validation has a cost

Validating network data adds processing and implementation complexity, particularly for high-volume streams.

### Server-state handling requires a separate strategy

The architecture identifies server state as a distinct category but intentionally does not select a query/cache library in this ADR.

### UI models may differ from API contracts

The frontend may need explicit mapping from transport responses to UI-friendly models. This is intentional because the two boundaries have different responsibilities.

# Deferred Decisions

The following remain outside the scope of ADR-009:

## 1. State-Management Library

No specific global state-management library is selected.

## 2. Server-State / Query-Cache Library

The architecture requires a server-state distinction but does not select a query/cache implementation.

## 3. Form Library

No form-management library is selected.

## 4. Routing Library

The architecture defines route composition under `app/` and `pages/` but does not select a routing implementation.

## 5. Exact Runtime Validation Library

Runtime validation is required where Atlas defines a runtime contract schema, but the specific schema-validation library remains a separate implementation decision.

## 6. Market-Data Validation Strategy

High-volume market-data streams may require a separately justified validation/performance policy.

## 7. Exact Feature Public Interfaces

The existence of public feature boundaries is architectural. Exact exports and TypeScript interfaces will evolve with the application.

## 8. Exact Folder and File Names

The example directory structure is illustrative.

The ownership and dependency rules are normative.

# Reconsideration Criteria

This architecture should be reconsidered when a measurable requirement emerges.

Relevant triggers include:

- feature dependencies become difficult to keep acyclic;
- feature boundaries repeatedly prove incorrect;
- frontend scale makes the current composition model difficult to maintain;
- server-state coordination becomes a major performance or correctness concern;
- runtime validation becomes a material performance bottleneck;
- a large frontend team requires stronger standardized methodology;
- independent deployment or scaling of frontend capabilities becomes necessary;
- shared abstractions repeatedly acquire business-specific semantics.

A formal frontend methodology, micro-frontends, or a larger state architecture should not be introduced merely because the application has grown in file count.

The trigger should be a demonstrated architectural or operational problem.

# Relationship to Other Decisions

The TypeScript module, execution, and build strategy is established by:

[ADR-007 — TypeScript Module, Execution, and Build Strategy](ADR-007-typescript-module-execution-and-build-strategy.md)

The Node.js runtime baseline is established by:

[ADR-006 — Node.js Runtime Baseline](ADR-006-nodejs-runtime-baseline.md)

The backend application architecture is established by:

[ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)

The testing toolchain is established by:

[ADR-005 — Sprint 1 Testing Toolchain](ADR-005-sprint-1-testing-toolchain.md)

Testing architecture is established by:

[ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)

Workspace and package-management decisions are established by:

[ADR-003 — Workspace and Package Management Strategy](ADR-003-workspace-and-package-management-strategy.md)

Repository structure is established by:

[ADR-002 — Project Folder Structure](ADR-002-project-folder-structure.md)

Documentation authority and lifecycle are governed by:

[Documentation Governance](../../governance/documentation-governance.md)

# Status

**Accepted**

Atlas adopts a pragmatic feature-first frontend architecture.

Frontend business behavior is organized by user-facing capability, with application composition in `app/`, route-level composition in `pages/`, feature behavior in `features/`, and genuinely domain-neutral reusable code in `shared/`.

Feature dependencies must remain explicit and acyclic. Server state remains backend-authoritative, and financially important operations are not represented as successful before server confirmation.

`@atlas/contracts` is a shared transport-contract definition boundary, not a runtime request path and not a container for backend domain models or frontend presentation models.

No specific state-management, query-cache, form, routing, or runtime-validation library is selected by this ADR.
