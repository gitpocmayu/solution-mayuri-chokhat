# Subscription & Billing Service test fixture

## Overview

This repository is a small executable service fixture and behavior-focused test suite for a subscription billing workflow. It demonstrates how to validate API behavior, lifecycle rules, persisted side effects, webhook delivery, and an external payment boundary without connecting to a real provider.

## Scope and assumptions

- `basic` and `pro` subscriptions begin in a trial. Their configured trial length and price are persisted and exposed; an initial charge happens only when the plan configuration says `chargeImmediately`.
- Customers are seeded in a small in-memory customer repository (`cust_001` by default); a well-formed unknown customer is rejected. Payment methods remain external identities and are validated by `pm_` ID shape.
- Plan changes update plan pricing for future billing immediately, without proration or an immediate charge. A canceled subscription cannot change plans.
- A billing attempt creates an invoice before calling the provider. Provider outcomes are definitive success, decline, or timeout. A timeout is recorded as failed for this deterministic fixture; real systems may need an `unknown` state and reconciliation.
- Webhooks describe invoice outcomes and are authenticated with HMAC-SHA256 over the exact raw request bytes. `payment.refunded` records a refund event and does not change subscription lifecycle state.
- The in-memory repositories are isolated per test fixture. They model queryable persistence semantics, not disk durability or database transaction/concurrency behavior.

## Architecture

The Express application delegates HTTP validation to a controller, business operations to `SubscriptionService` and `WebhookService`, lifecycle changes to `SubscriptionLifecycle`, and data access to repository interfaces. `MockPaymentProvider` is injected through `PaymentProvider`; tests assert the actual billing arguments and recorded outcomes. `SubscriptionApiClient` and builders keep test scenarios focused on business intent. `SubscriptionTestEnvironment` creates a fresh app, repositories, and provider for every test.

### Patterns and why they fit

- **Explicit state transition table** in `SubscriptionLifecycle`: one place defines legal lifecycle changes and rejects illegal ones, instead of allowing arbitrary status writes.
- **Builder** in `tests/support/builders.ts`: customer, subscription, and webhook data can be varied by intent without repeating large payload literals.
- **Dependency injection / strategy seam** through `PaymentProvider`: the service can exercise success, decline, and timeout outcomes without network access.
- **Repository** interfaces with in-memory implementations: service logic and persistence assertions use named operations rather than reaching into maps or HTTP responses.
- **Fixture factory** (`SubscriptionTestEnvironment`): each scenario gets a clean, consistent graph of collaborators, preventing stale records from masking failures.

## API contract

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/subscriptions` | Accepts `{ customer_id, plan, payment_method_id }`; returns `201` and the created subscription. |
| `GET` | `/subscriptions/:id` | Returns the current subscription, or `404`. |
| `POST` | `/subscriptions/:id/cancel` | Transitions a non-canceled subscription to terminal `canceled`; repeated cancellation returns `409`. |
| `PATCH` | `/subscriptions/:id/plan` | Changes plan pricing for future billing without proration or an immediate charge. |
| `POST` | `/webhooks/payment-provider` | Accepts signed `payment.succeeded`, `payment.failed`, or `payment.refunded` events. |

Validation errors return a stable `{ error: { code, message } }` payload. Webhook authentication uses `X-Provider-Signature` as a hex HMAC-SHA256. A correctly signed malformed/unknown event gets `400`; invalid or missing signatures get `401`.

## Test strategy

- **API and end-to-end:** use Supertest through a typed API client to cover creation, retrieval, cancellation, validation, and signed webhook flows.
- **Lifecycle unit level:** enumerate every allowed transition and representative rejected transitions directly against the state model.
- **Persistence:** query subscription, invoice, webhook-event, and audit repositories after each material flow and compare stored state with the API view.
- **Provider integration seam:** configure success, decline, and timeout responses and assert count plus customer, amount, payment method, and idempotency key.
- **Webhook reliability:** cover authentication, malformed/unknown input, unknown subscriptions, duplicate IDs, and success followed by failure for the same invoice.

Tests are grouped by behavior under `tests/api`, `tests/lifecycle`, `tests/webhook`, `tests/persistence`, and `tests/integration`. Test data builders and assertion helpers live under `tests/support`.

## Lifecycle

| Current state | Trigger | Next state |
| --- | --- | --- |
| trialing | payment succeeds | active |
| trialing | payment fails | past_due |
| trialing | customer cancels | canceled |
| active | payment fails | past_due |
| active | customer cancels | canceled |
| past_due | payment succeeds | active |
| past_due | customer cancels | canceled |
| past_due | retries exhausted | canceled |

`canceled` is terminal. A success event for a canceled subscription is acknowledged and recorded without changing its state. A failure event cannot overwrite a successful invoice, so a late failure for that invoice does not regress the subscription. Retry exhaustion is represented as a service-level trigger; no scheduler is included.

## Persistence Validation

Persistence uses isolated in-memory repositories. This keeps the assignment focused on verifying stored business state and side effects rather than adding a database driver; the limitation is that these stores do not model disk durability, transactions, or concurrency.

The repositories expose four entities:

- `SubscriptionRepository`: subscription/customer IDs, plan, status, payment method, configured price/trial, and timestamps.
- `InvoiceRepository`: invoice/subscription/customer IDs, amount, currency, status, provider reference, idempotency key, and timestamps.
- `WebhookEventRepository`: event ID/type, subscription/invoice IDs, disposition, and receipt timestamp. It retains each delivery so the original processing and duplicate receipt can both be inspected.
- `AuditEventRepository`: subscription ID, event type, prior/next state, reference ID, and timestamp.

`tests/persistence/persistence-invariants.test.ts` performs business operations through the API or service, then queries repositories. It checks creation/API agreement, provider success and decline, invoice-to-plan price consistency, audit references, duplicate/out-of-order webhook effects, cancellation terminality, rejected billing/cancellation, and provider-call absence where appropriate. The webhook and provider integration suites also verify persisted outcomes at their natural behavior level.

Each test creates a new `SubscriptionTestEnvironment`, which constructs fresh repositories, services, and mock provider state. No repository or event ID is shared between tests.

The core invariants are: active has a successful persisted invoice for its activation flow; canceled subscriptions stay canceled and cannot be charged; duplicate IDs do not repeat invoice or audit effects; provider calls use the plan amount and customer; API-visible status matches repository state; and later failures cannot overwrite successful invoices.

```text
API Request
    ↓
Service
    ↓
State Machine
    ↓
Payment Provider (mock for charge attempts; signed events for webhook outcomes)
    ↓
Repositories
    ↓
Persistence
    ↓
Assertions
```

## Idempotency and persistence behavior

The webhook event repository reserves event IDs before applying effects. A repeated ID is recorded as a duplicate delivery and acknowledged without repeating invoice transitions, audit effects, or provider calls. Invoice outcomes are monotonic: a succeeded invoice cannot return to failed. A distinct later event for a terminal/canceled subscription is still recorded for traceability, while lifecycle rules prevent reactivation.

Webhook outcomes update an existing invoice. For one invoice, failure may be recovered by a later success, while success is terminal against later failure. A canceled subscription can retain the completed payment outcome on its invoice without receiving an activation audit event.

## Development Discipline

Important changes in this review followed Red / Blue / Green with executable evidence:

- **Provider success and failure persistence:** RED added repository specifications that expected a charge to update API-visible lifecycle state and persist an invoice-linked audit record. Running `npm test -- tests/persistence/persistence-invariants.test.ts` failed: both outcomes left the subscription `trialing`, and the payment audit reference was absent. BLUE moved outcome application into `SubscriptionService.charge()` and passed the invoice ID to the audit event. GREEN removed duplicate caller-side state updates from the API/provider integration scenarios; the service now owns that transition once. The persistence specifications then passed.
- **Canceled subscriptions cannot be billed:** RED added a specification requiring a rejected charge and no invoice, provider call, or new audit event. Its focused test run failed because `charge()` returned a successful invoice for a canceled subscription. BLUE added the billability guard before invoice creation. The focused test then passed and verifies all four persistence/side-effect expectations.

Duplicate webhook delivery and canceled-webhook terminality also have regression specifications in the persistence and webhook suites. Their original intermediate RED states are not claimed here: those tests predated this review. This workspace has no `.git` directory, so there is no commit history to use as additional evidence.

## Real vs mocked

**Real:** service rules, lifecycle model, Express routing, raw-body HMAC verification, and in-memory persistence behavior.

**Mocked:** payment provider. It is a deterministic test double with configurable success, decline, and timeout outcomes. Webhook deliveries are constructed and signed by the test suite. There is no live provider network dependency.

## Tradeoffs and limitations

SQLite was not added because this assignment evaluates persistence verification and workflow behavior rather than database-driver integration; isolated in-memory repositories keep tests deterministic and fast. The fixture omits authentication, retries/schedulers, proration, taxes, multiple currencies, durable transactions, and concurrent webhook locking. In-memory event ID reservation demonstrates sequential idempotency only; production storage must enforce uniqueness transactionally. Refunds are audited but do not implement refund accounting or subscription changes.

## Running locally

```sh
npm install
npm test
npm run build
npm run lint
npm run test:coverage
```

Final verification passed: **54 tests across 5 suites**, with **97.05% statements, 93.33% branches, 97.95% functions, and 99.49% lines**. See [docs/ASSIGNMENT_TRACEABILITY.md](docs/ASSIGNMENT_TRACEABILITY.md) for requirement-by-requirement evidence.
