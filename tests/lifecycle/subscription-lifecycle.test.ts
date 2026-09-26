import { SubscriptionLifecycle } from '../../src/lifecycle';
import { DomainError, SubscriptionStatus } from '../../src/domain';

describe('subscription lifecycle', () => {
  const lifecycle = new SubscriptionLifecycle();
  const valid: Array<[SubscriptionStatus, 'payment_succeeded' | 'payment_failed' | 'customer_canceled' | 'retries_exhausted', SubscriptionStatus]> = [
    ['trialing', 'payment_succeeded', 'active'], ['trialing', 'payment_failed', 'past_due'], ['trialing', 'customer_canceled', 'canceled'],
    ['active', 'payment_failed', 'past_due'], ['active', 'customer_canceled', 'canceled'],
    ['past_due', 'payment_succeeded', 'active'], ['past_due', 'customer_canceled', 'canceled'], ['past_due', 'retries_exhausted', 'canceled']
  ];

  test.each(valid)('%s transitions to %s after %s', (from, trigger, to) => {
    expect(lifecycle.transition(from, trigger)).toBe(to);
  });

  test.each([
    ['canceled', 'payment_succeeded'], ['canceled', 'payment_failed'], ['active', 'payment_succeeded']
  ] as const)('rejects %s after %s', (from, trigger) => {
    expect(() => lifecycle.transition(from, trigger)).toThrow(DomainError);
  });
});
