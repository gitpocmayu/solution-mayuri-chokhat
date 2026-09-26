# Validation strategy

## Scope and assumptions

This is a minimal service fixture because no existing backend was supplied. Plans have explicit prices and trial durations and begin in trial unless configured for an immediate charge. Customers are seeded in an in-memory customer repository; payment-method identifiers are validated by shape because the provider is mocked. Provider timeouts are represented as a definitive failed invoice for determinism. Refunds are recorded but do not change subscription status. Plan changes affect future billing without proration.

## Test levels

- Lifecycle unit tests exercise each allowed edge and representative invalid edges.
- API tests validate request shape, status codes, and response payloads through a typed client.
- Plan-change API tests verify the new plan and price persist and are used by the next billing attempt.
- Integration tests inspect repositories after API/webhook activity and compare stored subscription state to API state.
- Payment seam tests inspect provider call count and business arguments under success, decline, and timeout outcomes.
- Webhook tests sign exact payload bytes and cover signature failures, schema failures, unknown references, duplicates, ordering, and cancellation terminality.

## Architecture and patterns

The HTTP controller delegates to focused services; repositories own persistence operations; an explicit lifecycle transition map guards status changes. `PaymentProvider` is injected, with a configurable recording mock in tests. Test builders create customers, subscription seeds, and webhook deliveries. A per-test environment creates fresh repository instances and collaborators to avoid stale-data false positives.

## Persistence checks

The in-memory stores expose subscriptions, invoices, webhook event dispositions, and audit history. `tests/persistence/persistence-invariants.test.ts` performs API/service business actions before querying these repositories; it checks subscription/API agreement, plan amount consistency, successful and failed payment outcomes, audit references, duplicate delivery, out-of-order delivery, terminal cancellation, and rejected charges. Every test receives fresh repositories and provider state from `SubscriptionTestEnvironment`.

Provider charge outcomes now update invoice and lifecycle state in one service operation, and the resulting audit entry references that invoice. A canceled subscription is rejected before invoice creation or provider interaction.

Retry exhaustion is an explicit service trigger from `past_due` to `canceled`; the fixture does not implement a retry scheduler. Plan changes update the configured plan/price used by the next charge, without proration.

## Webhook and idempotency strategy

The endpoint verifies HMAC-SHA256 over raw JSON bytes before parsing. It tracks `event_id`, and a duplicate returns an idempotent acknowledgment while retaining a duplicate-delivery record. Invoice status is monotonic once succeeded. This fixture proves sequential redelivery behavior; atomic uniqueness and concurrent processing need a transactional production store.

## Real and mocked components

Business rules, HTTP routing, signature verification, and repository behavior are real. The external provider is mocked; no network calls occur. Webhooks are generated and delivered by test support code.

## Limitations

No durable SQL database, provider reconciliation for ambiguous timeouts, concurrent webhook locking, auth, scheduler, retry policy, proration, tax, or full refund accounting is included. These are outside the focused take-home fixture.

## Red / Blue / Green evidence

This review added provider success/failure persistence specifications first; the initial focused test run failed because charge outcomes left subscriptions in `trialing` and payment audit entries lacked invoice references. The service then took ownership of outcome transitions, and callers were simplified to avoid applying outcomes twice. A second failing specification showed that canceled subscriptions could still be charged; a billability guard now rejects before invoice/provider side effects. The earlier duplicate-webhook and canceled-webhook tests remain regression evidence, but their original failing stages predate this review and are not claimed. No `.git` directory is present to preserve intermediate commits.
