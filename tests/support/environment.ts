import { createApp } from '../../src/app';
import { MockPaymentProvider } from '../../src/payment-provider';
import { PlanFactory } from '../../src/plans';
import { InMemoryAuditEventRepository, InMemoryCustomerRepository, InMemoryInvoiceRepository, InMemorySubscriptionRepository, InMemoryWebhookEventRepository } from '../../src/repositories';
import { SubscriptionService, WebhookService } from '../../src/services';
import { SubscriptionLifecycle } from '../../src/lifecycle';
import { SubscriptionApiClient } from './http-client';
import { CustomerBuilder } from './builders';

export const WEBHOOK_SECRET = 'test-secret-not-for-production';

export class SubscriptionTestEnvironment {
  readonly customers = new InMemoryCustomerRepository();
  readonly subscriptions = new InMemorySubscriptionRepository();
  readonly invoices = new InMemoryInvoiceRepository();
  readonly webhookEvents = new InMemoryWebhookEventRepository();
  readonly audit = new InMemoryAuditEventRepository();
  readonly provider = new MockPaymentProvider();
  readonly subscriptionService: SubscriptionService;
  readonly webhookService: WebhookService;
  readonly app: ReturnType<typeof createApp>;
  readonly client: SubscriptionApiClient;

  constructor(plans = new PlanFactory()) {
    this.customers.save(new CustomerBuilder().withId('cust_001').build());
    this.subscriptionService = new SubscriptionService(this.subscriptions, this.invoices, this.audit, this.provider, plans, new SubscriptionLifecycle(), this.customers);
    this.webhookService = new WebhookService(this.subscriptions, this.invoices, this.webhookEvents, this.audit, this.subscriptionService);
    this.app = createApp({ subscriptionService: this.subscriptionService, webhookService: this.webhookService, webhookSecret: WEBHOOK_SECRET });
    this.client = new SubscriptionApiClient(this.app, WEBHOOK_SECRET);
  }
}
