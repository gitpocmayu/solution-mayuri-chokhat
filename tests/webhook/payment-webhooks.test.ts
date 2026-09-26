import { WebhookEventBuilder } from '../support/builders';
import { SubscriptionTestEnvironment } from '../support/environment';
import { signWebhook } from '../../src/app';
import { WEBHOOK_SECRET } from '../support/environment';

describe('payment provider webhooks', () => {
  let environment: SubscriptionTestEnvironment;
  beforeEach(() => { environment = new SubscriptionTestEnvironment(); });

  const createPendingInvoice = async () => {
    const subscription = await environment.client.createValidSubscription('pro');
    const invoice = environment.subscriptionService.createInvoice(subscription);
    return { subscription, invoice };
  };

  test('activates a subscription and persists payment, webhook, and audit evidence after valid success', async () => {
    const { subscription, invoice } = await createPendingInvoice();
    const payload = new WebhookEventBuilder().with({ subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    const response = await environment.client.sendWebhook(payload);

    expect(response.status).toBe(200);
    expect(environment.invoices.findById(invoice.id)).toEqual(expect.objectContaining({ status: 'succeeded', providerReference: `webhook:${payload.event_id}` }));
    expect(environment.subscriptions.findById(subscription.id)?.status).toBe('active');
    expect(environment.audit.forSubscription(subscription.id).map(event => event.to)).toEqual(['trialing', 'active']);
    expect(environment.webhookEvents.all()).toEqual([expect.objectContaining({ eventId: payload.event_id, disposition: 'processed' })]);
  });

  test('processes the same webhook event exactly once without duplicate payment or audit effects', async () => {
    const { subscription, invoice } = await createPendingInvoice();
    const payload = new WebhookEventBuilder().with({ subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    const first = await environment.client.sendWebhook(payload);
    const second = await environment.client.sendWebhook(payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(environment.subscriptions.findById(subscription.id)?.status).toBe('active');
    expect(environment.invoices.all()).toHaveLength(1);
    expect(environment.audit.forSubscription(subscription.id)).toHaveLength(2);
    expect(environment.webhookEvents.all()).toHaveLength(2);
    expect(environment.webhookEvents.all().map(event => event.disposition)).toEqual(['processed', 'duplicate']);
    expect(environment.provider.calls).toHaveLength(0);
  });

  test('does not regress a successful invoice when a later failure event arrives for that invoice', async () => {
    const { subscription, invoice } = await createPendingInvoice();
    const success = new WebhookEventBuilder().with({ event_id: 'evt_success', subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    const failure = new WebhookEventBuilder().with({ event_id: 'evt_late_failure', type: 'payment.failed', subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    await environment.client.sendWebhook(success);
    const response = await environment.client.sendWebhook(failure);

    expect(response.status).toBe(200);
    expect(environment.invoices.findById(invoice.id)?.status).toBe('succeeded');
    expect(environment.subscriptions.findById(subscription.id)?.status).toBe('active');
    expect(environment.audit.forSubscription(subscription.id)).toHaveLength(2);
    expect(environment.webhookEvents.all()).toHaveLength(2);
  });

  test('recovers the same invoice and subscription when a successful retry follows an earlier failure', async () => {
    const { subscription, invoice } = await createPendingInvoice();
    const failure = new WebhookEventBuilder().with({ event_id: 'evt_attempt_failed', type: 'payment.failed', subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    const success = new WebhookEventBuilder().with({ event_id: 'evt_attempt_recovered', type: 'payment.succeeded', subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    await environment.client.sendWebhook(failure);
    const response = await environment.client.sendWebhook(success);
    expect(response.status).toBe(200);
    expect(environment.invoices.findById(invoice.id)?.status).toBe('succeeded');
    expect(environment.subscriptions.findById(subscription.id)?.status).toBe('active');
    expect(environment.audit.forSubscription(subscription.id).map(event => event.to)).toEqual(['trialing', 'past_due', 'active']);
  });

  test('does not reactivate a canceled subscription when payment.succeeded arrives later', async () => {
    const { subscription, invoice } = await createPendingInvoice();
    const cancel = await environment.client.cancelSubscription(subscription.id);
    const payload = new WebhookEventBuilder().with({ subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    const response = await environment.client.sendWebhook(payload);

    expect(cancel.body.status).toBe('canceled');
    expect(response.status).toBe(200);
    expect(environment.subscriptions.findById(subscription.id)?.status).toBe('canceled');
    expect(environment.invoices.findById(invoice.id)?.status).toBe('succeeded');
    expect(environment.provider.calls).toHaveLength(0);
  });

  test('records failure and moves trialing to past_due without creating a success record', async () => {
    const { subscription, invoice } = await createPendingInvoice();
    const failure = new WebhookEventBuilder().with({ type: 'payment.failed', subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    const response = await environment.client.sendWebhook(failure);
    expect(response.status).toBe(200);
    expect(environment.invoices.findById(invoice.id)?.status).toBe('failed');
    expect(environment.subscriptions.findById(subscription.id)?.status).toBe('past_due');
    expect(environment.invoices.all().filter(row => row.status === 'succeeded')).toHaveLength(0);
  });

  test('allows a successful retry to reactivate a past_due subscription', async () => {
    const { subscription, invoice } = await createPendingInvoice();
    const failed = new WebhookEventBuilder().with({ event_id: 'evt_failed_first', type: 'payment.failed', subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    await environment.client.sendWebhook(failed);
    const retryInvoice = environment.subscriptionService.createInvoice(environment.subscriptions.findById(subscription.id)!);
    const succeeded = new WebhookEventBuilder().with({ event_id: 'evt_retry_success', type: 'payment.succeeded', subscription_id: subscription.id, invoice_id: retryInvoice.id, amount: retryInvoice.amount }).build();
    const response = await environment.client.sendWebhook(succeeded);
    expect(response.status).toBe(200);
    expect(environment.subscriptions.findById(subscription.id)?.status).toBe('active');
    expect(environment.invoices.findById(invoice.id)?.status).toBe('failed');
    expect(environment.invoices.findById(retryInvoice.id)?.status).toBe('succeeded');
    expect(environment.audit.forSubscription(subscription.id).map(event => event.to)).toEqual(['trialing', 'past_due', 'active']);
    expect(environment.provider.calls).toHaveLength(0);
  });

  test('does not let a late failure for an older invoice regress a successful retry', async () => {
    const { subscription, invoice } = await createPendingInvoice();
    const firstFailure = new WebhookEventBuilder().with({ event_id: 'evt_first_failure', type: 'payment.failed', subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    await environment.client.sendWebhook(firstFailure);
    const retryInvoice = environment.subscriptionService.createInvoice(environment.subscriptions.findById(subscription.id)!);
    const retrySuccess = new WebhookEventBuilder().with({ event_id: 'evt_retry_success', type: 'payment.succeeded', subscription_id: subscription.id, invoice_id: retryInvoice.id, amount: retryInvoice.amount }).build();
    await environment.client.sendWebhook(retrySuccess);
    const lateFailure = new WebhookEventBuilder().with({ event_id: 'evt_late_old_failure', type: 'payment.failed', subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    await environment.client.sendWebhook(lateFailure);

    expect(environment.subscriptions.findById(subscription.id)?.status).toBe('active');
    expect(environment.invoices.findById(invoice.id)?.status).toBe('failed');
    expect(environment.invoices.findById(retryInvoice.id)?.status).toBe('succeeded');
    expect(environment.audit.forSubscription(subscription.id).map(event => event.to)).toEqual(['trialing', 'past_due', 'active']);
  });

  test('rejects a signed event whose amount conflicts with the persisted invoice', async () => {
    const { subscription, invoice } = await createPendingInvoice();
    const payload = new WebhookEventBuilder().with({ subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount + 1 }).build();
    const response = await environment.client.sendWebhook(payload);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('PAYMENT_MISMATCH');
    expect(environment.invoices.findById(invoice.id)?.status).toBe('pending');
    expect(environment.subscriptions.findById(subscription.id)?.status).toBe('trialing');
    expect(environment.webhookEvents.all()[0].disposition).toBe('rejected');
  });

  test('acknowledges refunds as invoice and audit events without changing subscription lifecycle', async () => {
    const { subscription, invoice } = await createPendingInvoice();
    const success = new WebhookEventBuilder().with({ subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    await environment.client.sendWebhook(success);
    const refund = new WebhookEventBuilder().with({ event_id: 'evt_refund', type: 'payment.refunded', subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    const response = await environment.client.sendWebhook(refund);
    expect(response.status).toBe(200);
    expect(environment.invoices.findById(invoice.id)?.status).toBe('refunded');
    expect(environment.subscriptions.findById(subscription.id)?.status).toBe('active');
    expect(environment.audit.forSubscription(subscription.id)).toHaveLength(3);
  });

  test('rejects absent or forged signatures before applying any event', async () => {
    const { subscription, invoice } = await createPendingInvoice();
    const payload = new WebhookEventBuilder().with({ subscription_id: subscription.id, invoice_id: invoice.id, amount: invoice.amount }).build();
    const raw = JSON.stringify(payload);
    const missing = await environment.client.sendWebhook(payload, '');
    const forged = await environment.client.sendWebhook(payload, '0'.repeat(64));
    expect(missing.status).toBe(401);
    expect(forged.status).toBe(401);
    expect(environment.webhookEvents.all()).toHaveLength(0);
    expect(environment.invoices.findById(invoice.id)?.status).toBe('pending');
    expect(signWebhook(raw, WEBHOOK_SECRET)).not.toBe('0'.repeat(64));
  });

  test('rejects malformed and unknown event payloads before business effects', async () => {
    const badSchema = await environment.client.sendWebhook(new WebhookEventBuilder().with({ type: 'payment.unknown' as 'payment.succeeded' }).build());
    expect(badSchema.status).toBe(400);
    expect(badSchema.body.error.code).toBe('MALFORMED_WEBHOOK');
    expect(environment.webhookEvents.all()).toHaveLength(0);
  });

  test('rejects malformed JSON even when its raw bytes have a valid signature', async () => {
    const response = await environment.client.sendRawWebhook('{"event_id":', signWebhook('{"event_id":', WEBHOOK_SECRET));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MALFORMED_JSON');
    expect(environment.webhookEvents.all()).toHaveLength(0);
  });

  test('records a correctly signed event with unknown references as rejected', async () => {
    const payload = new WebhookEventBuilder().build();
    const response = await environment.client.sendWebhook(payload);
    expect(response.status).toBe(404);
    expect(environment.webhookEvents.all()).toEqual([expect.objectContaining({ eventId: payload.event_id, disposition: 'rejected' })]);
    expect(environment.invoices.all()).toHaveLength(0);
  });
});
