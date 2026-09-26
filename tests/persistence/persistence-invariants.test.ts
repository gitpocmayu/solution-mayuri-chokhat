import { SubscriptionTestEnvironment } from '../support/environment';
import { WebhookEventBuilder } from '../support/builders';
import { expectProviderCalledOnceWith } from '../support/assertions';

describe('billing persistence invariants', () => {
  let environment: SubscriptionTestEnvironment;
  beforeEach(() => { environment = new SubscriptionTestEnvironment(); });

  test('persists a successful provider charge before exposing the active subscription', async () => {
    const createdResponse = await environment.client.createSubscription({
      customer_id: 'cust_001', plan: 'pro', payment_method_id: 'pm_test_persist'
    });
    const created = createdResponse.body;
    const invoice = await environment.subscriptionService.charge(environment.subscriptions.findById(created.id)!);
    const visible = await environment.client.getSubscription(created.id);
    const stored = environment.invoices.findById(invoice.id)!;
    const paymentAudit = environment.audit.forSubscription(created.id).find(event => event.type === 'payment.succeeded');

    expect(createdResponse.status).toBe(201);
    expect(visible.body).toEqual(expect.objectContaining({ id: created.id, status: 'active', plan: 'pro' }));
    expect(environment.subscriptions.findById(created.id)).toEqual(visible.body);
    expect(stored).toEqual(expect.objectContaining({
      subscriptionId: created.id, customerId: 'cust_001', amount: created.price, currency: 'USD', status: 'succeeded',
      providerReference: expect.stringMatching(/^pay_/)
    }));
    expect(Date.parse(stored.updatedAt)).toBeGreaterThanOrEqual(Date.parse(stored.createdAt));
    expect(environment.invoices.all().filter(row => row.subscriptionId === created.id && row.status === 'succeeded')).toHaveLength(1);
    expectProviderCalledOnceWith(environment.provider, { customerId: 'cust_001', amount: 4900, paymentMethodId: 'pm_test_persist' });
    expect(paymentAudit).toEqual(expect.objectContaining({ from: 'trialing', to: 'active', referenceId: invoice.id, createdAt: expect.any(String) }));
  });

  test('persists a declined provider charge as past_due without a successful payment record', async () => {
    const created = await environment.client.createValidSubscription('basic');
    environment.provider.queueOutcome('decline');
    const invoice = await environment.subscriptionService.charge(environment.subscriptions.findById(created.id)!);
    const visible = await environment.client.getSubscription(created.id);
    const failureAudit = environment.audit.forSubscription(created.id).find(event => event.type === 'payment.failed');

    expect(visible.body.status).toBe('past_due');
    expect(environment.subscriptions.findById(created.id)).toEqual(visible.body);
    expect(environment.invoices.findById(invoice.id)).toEqual(expect.objectContaining({
      subscriptionId: created.id, amount: 1200, currency: 'USD', status: 'failed', providerReference: expect.stringMatching(/^pay_/)
    }));
    expect(environment.invoices.all().filter(row => row.subscriptionId === created.id && row.status === 'succeeded')).toHaveLength(0);
    expect(failureAudit).toEqual(expect.objectContaining({ from: 'trialing', to: 'past_due', referenceId: invoice.id }));
  });

  test('persists the requested plan and customer on creation and keeps the API view in sync', async () => {
    const response = await environment.client.createSubscription({
      customer_id: 'cust_001', plan: 'basic', payment_method_id: 'pm_test_basic'
    });
    const stored = environment.subscriptions.findById(response.body.id)!;

    expect(response.status).toBe(201);
    expect(stored).toEqual(expect.objectContaining({
      id: response.body.id, customerId: 'cust_001', plan: 'basic', status: 'trialing',
      price: 1200, trialDays: 7, paymentMethodId: 'pm_test_basic'
    }));
    expect(response.body).toEqual(stored);
    expect(environment.invoices.all()).toHaveLength(0);
    expect(environment.audit.forSubscription(stored.id)).toEqual([
      expect.objectContaining({ type: 'subscription.created', to: 'trialing', createdAt: expect.any(String) })
    ]);
  });

  test('records duplicate webhook delivery while applying invoice and audit effects once', async () => {
    const subscription = await environment.client.createValidSubscription();
    const invoice = environment.subscriptionService.createInvoice(subscription);
    const payload = new WebhookEventBuilder().with({ subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    const first = await environment.client.sendWebhook(payload);
    const replay = await environment.client.sendWebhook(payload);
    const eventDeliveries = environment.webhookEvents.all();

    expect(first.body.duplicate).toBe(false);
    expect(replay.body.duplicate).toBe(true);
    expect(eventDeliveries).toHaveLength(2);
    expect(eventDeliveries.map(event => event.disposition)).toEqual(['processed', 'duplicate']);
    expect(eventDeliveries.every(event => Number.isFinite(Date.parse(event.receivedAt)))).toBe(true);
    expect(environment.invoices.all().filter(row => row.subscriptionId === subscription.id)).toHaveLength(1);
    expect(environment.invoices.findById(invoice.id)?.status).toBe('succeeded');
    expect(environment.audit.forSubscription(subscription.id).filter(event => event.type === 'payment.succeeded')).toHaveLength(1);
    expect(environment.provider.calls).toHaveLength(0);
  });

  test('keeps payment, subscription, and audit persistence coherent for success followed by failure', async () => {
    const subscription = await environment.client.createValidSubscription();
    const invoice = environment.subscriptionService.createInvoice(subscription);
    const success = new WebhookEventBuilder().with({ event_id: 'evt_persist_success', subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    const lateFailure = new WebhookEventBuilder().with({ event_id: 'evt_persist_late_failure', type: 'payment.failed', subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    await environment.client.sendWebhook(success);
    const failureResponse = await environment.client.sendWebhook(lateFailure);

    expect(failureResponse.status).toBe(200);
    expect(environment.invoices.findById(invoice.id)?.status).toBe('succeeded');
    expect(environment.subscriptions.findById(subscription.id)?.status).toBe('active');
    expect(environment.audit.forSubscription(subscription.id).filter(event => event.to === 'active')).toHaveLength(1);
    expect(environment.webhookEvents.all().map(event => event.disposition)).toEqual(['processed', 'processed']);
  });

  test('persists cancellation as terminal when a later success webhook is received', async () => {
    const subscription = await environment.client.createValidSubscription();
    const invoice = environment.subscriptionService.createInvoice(subscription);
    const canceledResponse = await environment.client.cancelSubscription(subscription.id);
    const success = new WebhookEventBuilder().with({ subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    const webhookResponse = await environment.client.sendWebhook(success);
    const audit = environment.audit.forSubscription(subscription.id);

    expect(canceledResponse.body.status).toBe('canceled');
    expect(webhookResponse.status).toBe(200);
    expect(environment.subscriptions.findById(subscription.id)?.status).toBe('canceled');
    expect(environment.invoices.findById(invoice.id)?.status).toBe('succeeded');
    expect(audit.map(event => event.type)).toEqual(['subscription.created', 'subscription.canceled']);
    expect(audit.some(event => event.to === 'active')).toBe(false);
  });

  test('leaves persisted state and audit history unchanged after cancellation is rejected twice', async () => {
    const subscription = await environment.client.createValidSubscription();
    await environment.client.cancelSubscription(subscription.id);
    const auditBeforeRetry = environment.audit.forSubscription(subscription.id);
    const retry = await environment.client.cancelSubscription(subscription.id);

    expect(retry.status).toBe(409);
    expect(environment.subscriptions.findById(subscription.id)?.status).toBe('canceled');
    expect(environment.invoices.all()).toHaveLength(0);
    expect(environment.audit.forSubscription(subscription.id)).toEqual(auditBeforeRetry);
    expect(environment.provider.calls).toHaveLength(0);
  });

  test('does not create an invoice or call the provider for a canceled subscription', async () => {
    const subscription = await environment.client.createValidSubscription();
    await environment.client.cancelSubscription(subscription.id);
    const auditBeforeCharge = environment.audit.forSubscription(subscription.id);

    await expect(environment.subscriptionService.charge(environment.subscriptions.findById(subscription.id)!))
      .rejects.toMatchObject({ code: 'SUBSCRIPTION_NOT_BILLABLE', statusCode: 409 });

    expect(environment.subscriptions.findById(subscription.id)?.status).toBe('canceled');
    expect(environment.invoices.all()).toHaveLength(0);
    expect(environment.audit.forSubscription(subscription.id)).toEqual(auditBeforeCharge);
    expect(environment.provider.calls).toHaveLength(0);
  });

  test('cancels a past_due subscription when billing retries are exhausted and persists the transition', async () => {
    const subscription = await environment.client.createValidSubscription();
    environment.provider.queueOutcome('decline');
    await environment.subscriptionService.charge(subscription);
    const pastDue = environment.subscriptions.findById(subscription.id)!;
    const canceled = environment.subscriptionService.exhaustRetries(pastDue.id);
    const visible = await environment.client.getSubscription(subscription.id);

    expect(canceled.status).toBe('canceled');
    expect(visible.body.status).toBe('canceled');
    expect(environment.subscriptions.findById(subscription.id)).toEqual(visible.body);
    expect(environment.invoices.all().map(invoice => invoice.status)).toEqual(['failed']);
    expect(environment.audit.forSubscription(subscription.id).map(event => event.type)).toEqual([
      'subscription.created', 'payment.failed', 'subscription.retries_exhausted'
    ]);
  });
});
