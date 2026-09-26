import { SubscriptionTestEnvironment } from '../support/environment';
import { SubscriptionBuilder } from '../support/builders';
import { expectSubscriptionPersisted } from '../support/assertions';
import { expectProviderCalledOnceWith } from '../support/assertions';

describe('subscription API', () => {
  let environment: SubscriptionTestEnvironment;
  beforeEach(() => { environment = new SubscriptionTestEnvironment(); });

  test('creates a trial using the selected plan rules and persists the API-visible subscription', async () => {
    const requestBody = new SubscriptionBuilder().withPlan('pro').build();
    const response = await environment.client.createSubscription(requestBody);

    expect(response.status).toBe(201);
    expect(response.body).toEqual(expect.objectContaining({ plan: 'pro', price: 4900, trialDays: 14, status: 'trialing' }));
    expectSubscriptionPersisted(environment, response.body);
    expect(environment.provider.calls).toHaveLength(0);
    expect(environment.audit.forSubscription(response.body.id)).toHaveLength(1);
  });

  test('retrieves the subscription currently stored by the service', async () => {
    const created = await environment.client.createValidSubscription('basic');
    const response = await environment.client.getSubscription(created.id);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(environment.subscriptions.findById(created.id));
    expect(response.body).toEqual(expect.objectContaining({ price: 1200, trialDays: 7 }));
  });

  test('returns not found for an unknown subscription', async () => {
    const response = await environment.client.getSubscription('sub_missing');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('SUBSCRIPTION_NOT_FOUND');
  });

  test('rejects a well-formed but unknown customer without persisting or charging', async () => {
    const response = await environment.client.createSubscription({ customer_id: 'cust_unknown', plan: 'pro', payment_method_id: 'pm_test_visa' });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('CUSTOMER_NOT_FOUND');
    expect(environment.subscriptions.all()).toHaveLength(0);
    expect(environment.invoices.all()).toHaveLength(0);
    expect(environment.provider.calls).toHaveLength(0);
  });

  test('changes a plan for future billing and persists its price without charging immediately', async () => {
    const created = await environment.client.createValidSubscription('pro');
    const response = await environment.client.changePlan(created.id, 'basic');
    const stored = environment.subscriptions.findById(created.id);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ plan: 'basic', price: 1200, trialDays: 7, status: 'trialing' }));
    expect(stored).toEqual(response.body);
    expect(environment.invoices.all()).toHaveLength(0);
    expect(environment.provider.calls).toHaveLength(0);
    expect(environment.audit.forSubscription(created.id).at(-1)).toEqual(expect.objectContaining({ type: 'subscription.plan_changed', referenceId: 'plan:basic' }));

    const invoice = await environment.subscriptionService.charge(stored!);
    expect(invoice).toEqual(expect.objectContaining({ subscriptionId: created.id, amount: 1200, status: 'succeeded' }));
    expectProviderCalledOnceWith(environment.provider, { customerId: 'cust_001', amount: 1200, paymentMethodId: 'pm_test_visa_4242' });
    expect(environment.invoices.findById(invoice.id)?.amount).toBe(stored?.price);
  });

  test('rejects plan changes after cancellation without adding billing or audit side effects', async () => {
    const created = await environment.client.createValidSubscription('pro');
    await environment.client.cancelSubscription(created.id);
    const auditBeforeChange = environment.audit.forSubscription(created.id);
    const response = await environment.client.changePlan(created.id, 'basic');

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SUBSCRIPTION_CANCELED');
    expect(environment.subscriptions.findById(created.id)).toEqual(expect.objectContaining({ status: 'canceled', plan: 'pro', price: 4900 }));
    expect(environment.audit.forSubscription(created.id)).toEqual(auditBeforeChange);
    expect(environment.invoices.all()).toHaveLength(0);
    expect(environment.provider.calls).toHaveLength(0);
  });

  test.each([
    ['unknown plan', { customer_id: 'cust_001', plan: 'enterprise', payment_method_id: 'pm_test' }, 'INVALID_PLAN'],
    ['missing customer', { plan: 'pro', payment_method_id: 'pm_test' }, 'INVALID_CUSTOMER'],
    ['invalid customer', { customer_id: 'not-a-customer', plan: 'pro', payment_method_id: 'pm_test' }, 'INVALID_CUSTOMER'],
    ['missing payment method', { customer_id: 'cust_001', plan: 'pro' }, 'INVALID_PAYMENT_METHOD'],
    ['invalid payment method', { customer_id: 'cust_001', plan: 'pro', payment_method_id: 'invalid' }, 'INVALID_PAYMENT_METHOD']
  ])('rejects creation with %s without saving or charging', async (_case, body, code) => {
    const response = await environment.client.createSubscription(body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(code);
    expect(environment.subscriptions.all()).toHaveLength(0);
    expect(environment.provider.calls).toHaveLength(0);
  });

  test('cancels a trial without charging and rejects cancellation when already canceled', async () => {
    const created = await environment.client.createValidSubscription();
    const first = await environment.client.cancelSubscription(created.id);
    const repeat = await environment.client.cancelSubscription(created.id);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('canceled');
    expect(repeat.status).toBe(409);
    expect(environment.subscriptions.findById(created.id)?.status).toBe('canceled');
    expect(environment.provider.calls).toHaveLength(0);
    expect(environment.audit.forSubscription(created.id)).toHaveLength(2);
  });

  test.each(['trialing', 'active', 'past_due'] as const)('cancels a %s subscription as a terminal transition', async state => {
    const created = await environment.client.createValidSubscription();
    if (state === 'active' || state === 'past_due') {
      if (state === 'past_due') environment.provider.queueOutcome('decline');
      const invoice = await environment.subscriptionService.charge(created);
      expect(environment.invoices.findById(invoice.id)?.status).toBe(state === 'active' ? 'succeeded' : 'failed');
    }
    const response = await environment.client.cancelSubscription(created.id);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('canceled');
    expect(environment.subscriptions.findById(created.id)?.status).toBe('canceled');
    expect(environment.provider.calls).toHaveLength(state === 'trialing' ? 0 : 1);
  });
});
