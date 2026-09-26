# Subscription & Billing Service validation fixture

## Test strategy

The suite validates lifecycle rules directly, API contracts through Supertest, persisted outcomes through repositories, provider interactions through an injected mock, and end-to-end flows from request/webhook through stored state. Scope covers create/read/plan-change/cancel and payment outcome webhooks; UI, live provider behavior, performance, proration, tax, and production database integration are out of scope. Service logic and HTTP/signature behavior are real; provider calls are mocked and webhook deliveries are simulated.

## OOP and design patterns

- An explicit state transition table (`SubscriptionLifecycle`) makes illegal lifecycle changes rejectable in one place.
- Builders produce focused customer, subscription, and webhook test data.
- Dependency injection around `PaymentProvider` lets tests control outcomes and inspect exact charge requests.
- Repositories isolate service logic and allow persistence-level assertions; a per-test environment factory prevents shared-state leakage.

These patterns address concrete seams in lifecycle validation, repeated scenario setup, an external integration boundary, and persistence verification.

## API validation

`SubscriptionApiClient` encapsulates HTTP calls and exposes typed operations. Tests validate successful response codes and payloads, validation errors including unknown customers, retrieval including unknown IDs, cancellation, plan changes, and webhook signature/schema handling. Signature tests generate HMAC over the exact request bytes.

## Database validation

The dedicated `tests/persistence/persistence-invariants.test.ts` suite inspects subscriptions, invoices, webhook deliveries, and audit history through repositories after real API/service actions. It checks API/persistence agreement, provider success and decline, matching plan/invoice prices, audit references, duplicate and out-of-order delivery, cancellation, and absence of invalid side effects. Each test starts with fresh repositories and provider state.

## Mock provider and webhooks

The injected `MockPaymentProvider` supports success, decline, and timeout and records customer, amount, method, and idempotency key. Tests assert the actual request arguments and that invalid requests or webhook replay do not charge. Duplicate event IDs are acknowledged without applying a second transition or invoice effect; success followed by failure for the same invoice remains successful.

## Test architecture

Behavior is grouped in `tests/api`, `tests/lifecycle`, `tests/webhook`, `tests/persistence`, and `tests/integration`. Shared fixture construction, builders, API transport, and assertions live in `tests/support`, keeping scenarios readable while preserving repository-level evidence.

## Red / Blue / Green development

This review added failing persistence specifications before changing provider outcome handling and canceled-subscription charging. The failures exposed that provider charges left lifecycle state unchanged and that canceled subscriptions could still be charged. The service now owns charge outcome persistence and rejects canceled charges before side effects. Existing duplicate webhook and terminal cancellation tests are retained as regression specs; their historical Red stages are not claimed because they predated this review and no `.git` history is available in the workspace.


