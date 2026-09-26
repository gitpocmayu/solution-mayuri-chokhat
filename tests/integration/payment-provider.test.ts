import { expectProviderCalledOnceWith } from '../support/assertions';
import { SubscriptionTestEnvironment } from '../support/environment';
import { PlanFactory } from '../../src/plans';

describe('billing provider integration seam', () => {
  test.each([
    ['success', 'active', 'succeeded'], ['decline', 'past_due', 'failed'], ['timeout', 'past_due', 'failed']
  ] as const)('records %s outcome from the provider against the actual charge request', async (outcome, expectedStatus, invoiceStatus) => {
    const environment = new SubscriptionTestEnvironment();
    environment.provider.queueOutcome(outcome);
    const initial = await environment.client.createValidSubscription('basic');
    const invoice = await environment.subscriptionService.charge(initial);

    const visible = await environment.client.getSubscription(initial.id);
    expect(visible.body.status).toBe(expectedStatus);
    expect(environment.invoices.findById(invoice.id)?.status).toBe(invoiceStatus);
    expectProviderCalledOnceWith(environment.provider, { customerId: 'cust_001', amount: 1200, paymentMethodId: 'pm_test_visa_4242' });
    expect(environment.subscriptions.findById(initial.id)?.status).toBe(visible.body.status);
    if (expectedStatus === 'active') expect(environment.invoices.all().some(row => row.status === 'succeeded')).toBe(true);
  });

  test('moves an active subscription to past_due when a recurring invoice is declined', async () => {
    const environment = new SubscriptionTestEnvironment();
    const subscription = await environment.client.createValidSubscription('pro');
    const firstInvoice = await environment.subscriptionService.charge(subscription);
    environment.provider.queueOutcome('decline');
    const active = environment.subscriptions.findById(subscription.id)!;
    const recurringInvoice = await environment.subscriptionService.charge(active);
    const visible = await environment.client.getSubscription(subscription.id);

    expect(firstInvoice.status).toBe('succeeded');
    expect(recurringInvoice.status).toBe('failed');
    expect(visible.body.status).toBe('past_due');
    expect(environment.subscriptions.findById(subscription.id)).toEqual(visible.body);
    expect(environment.invoices.all().map(invoice => invoice.status)).toEqual(['succeeded', 'failed']);
    expect(environment.audit.forSubscription(subscription.id).map(event => event.to)).toEqual(['trialing', 'active', 'past_due']);
    expect(environment.provider.calls).toHaveLength(2);
    expect(environment.provider.calls.map(call => call.amount)).toEqual([4900, 4900]);
  });

  test('honors an immediate-charge plan configuration during subscription creation', async () => {
    const plans = new PlanFactory({ pro: { chargeImmediately: true } });
    const environment = new SubscriptionTestEnvironment(plans);
    const response = await environment.client.createSubscription({
      customer_id: 'cust_001', plan: 'pro', payment_method_id: 'pm_test_visa_4242'
    });
    const subscriptionId = response.body.id as string;
    const invoice = environment.invoices.all()[0];

    expect(response.status).toBe(201);
    expect(response.body).toEqual(expect.objectContaining({ status: 'active', plan: 'pro', price: 4900 }));
    expect(environment.subscriptions.findById(subscriptionId)).toEqual(response.body);
    expect(invoice).toEqual(expect.objectContaining({ subscriptionId, amount: 4900, status: 'succeeded' }));
    expectProviderCalledOnceWith(environment.provider, { customerId: 'cust_001', amount: 4900, paymentMethodId: 'pm_test_visa_4242' });
    expect(environment.audit.forSubscription(subscriptionId).map(event => event.to)).toEqual(['trialing', 'active']);
  });
});
