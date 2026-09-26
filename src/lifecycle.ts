import { DomainError, SubscriptionStatus } from './domain';

type Trigger = 'payment_succeeded' | 'payment_failed' | 'customer_canceled' | 'retries_exhausted';

const transitions: Record<SubscriptionStatus, Partial<Record<Trigger, SubscriptionStatus>>> = {
  trialing: { payment_succeeded: 'active', payment_failed: 'past_due', customer_canceled: 'canceled' },
  active: { payment_failed: 'past_due', customer_canceled: 'canceled' },
  past_due: { payment_succeeded: 'active', customer_canceled: 'canceled', retries_exhausted: 'canceled' },
  canceled: {}
};

export class SubscriptionLifecycle {
  transition(current: SubscriptionStatus, trigger: Trigger): SubscriptionStatus {
    const next = transitions[current][trigger];
    if (!next) throw new DomainError('INVALID_TRANSITION', `Cannot apply ${trigger} while subscription is ${current}`, 409);
    return next;
  }
}
