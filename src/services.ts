import { randomUUID } from 'node:crypto';
import { AuditEvent, DomainError, Invoice, Subscription, WebhookPayload } from './domain';
import { SubscriptionLifecycle } from './lifecycle';
import { PlanFactory } from './plans';
import { AuditEventRepository, CustomerRepository, InvoiceRepository, SubscriptionRepository, WebhookEventRepository } from './repositories';
import { PaymentProvider } from './payment-provider';

const now = (): string => new Date().toISOString();

export class SubscriptionService {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly invoices: InvoiceRepository,
    private readonly audit: AuditEventRepository,
    private readonly provider: PaymentProvider,
    private readonly plans: PlanFactory,
    private readonly lifecycle: SubscriptionLifecycle,
    private readonly customers: CustomerRepository
  ) {}

  async create(input: { customer_id?: unknown; plan?: unknown; payment_method_id?: unknown }): Promise<Subscription> {
    if (typeof input.customer_id !== 'string' || !/^cust_[\w-]+$/.test(input.customer_id)) throw new DomainError('INVALID_CUSTOMER', 'A valid customer_id is required');
    if (!this.customers.findById(input.customer_id)) throw new DomainError('CUSTOMER_NOT_FOUND', 'Customer not found', 404);
    if (typeof input.payment_method_id !== 'string' || !/^pm_[\w-]+$/.test(input.payment_method_id)) throw new DomainError('INVALID_PAYMENT_METHOD', 'A valid payment_method_id is required');
    let plan;
    try { plan = this.plans.get(input.plan); } catch { throw new DomainError('INVALID_PLAN', 'Plan must be basic or pro'); }

    const time = now();
    const subscription: Subscription = {
      id: `sub_${randomUUID()}`, customerId: input.customer_id, plan: plan.code, price: plan.price,
      trialDays: plan.trialDays, paymentMethodId: input.payment_method_id, status: 'trialing', createdAt: time, updatedAt: time
    };
    this.subscriptions.save(subscription);
    this.recordAudit(subscription, 'subscription.created', undefined, 'trialing');

    if (plan.chargeImmediately) {
      await this.charge(subscription);
    }
    return this.subscriptions.findById(subscription.id)!;
  }

  get(id: string): Subscription {
    const subscription = this.subscriptions.findById(id);
    if (!subscription) throw new DomainError('SUBSCRIPTION_NOT_FOUND', 'Subscription not found', 404);
    return subscription;
  }

  changePlan(id: string, requestedPlan: unknown): Subscription {
    const subscription = this.get(id);
    if (subscription.status === 'canceled') throw new DomainError('SUBSCRIPTION_CANCELED', 'A canceled subscription cannot change plans', 409);
    let plan;
    try { plan = this.plans.get(requestedPlan); } catch { throw new DomainError('INVALID_PLAN', 'Plan must be basic or pro'); }
    subscription.plan = plan.code;
    subscription.price = plan.price;
    subscription.trialDays = plan.trialDays;
    subscription.updatedAt = now();
    this.subscriptions.save(subscription);
    this.recordAudit(subscription, 'subscription.plan_changed', subscription.status, subscription.status, `plan:${plan.code}`);
    return this.get(id);
  }

  cancel(id: string): Subscription {
    const subscription = this.get(id);
    const next = this.lifecycle.transition(subscription.status, 'customer_canceled');
    this.move(subscription, next, 'subscription.canceled');
    return this.get(id);
  }

  exhaustRetries(id: string): Subscription {
    const subscription = this.get(id);
    const next = this.lifecycle.transition(subscription.status, 'retries_exhausted');
    this.move(subscription, next, 'subscription.retries_exhausted');
    return this.get(id);
  }

  async charge(subscription: Subscription): Promise<Invoice> {
    if (subscription.status === 'canceled') {
      throw new DomainError('SUBSCRIPTION_NOT_BILLABLE', 'Canceled subscriptions cannot be charged', 409);
    }
    const invoice = this.createInvoice(subscription);
    const result = await this.provider.charge({
      customerId: subscription.customerId, amount: invoice.amount, currency: invoice.currency,
      paymentMethodId: subscription.paymentMethodId, idempotencyKey: invoice.idempotencyKey
    });
    invoice.status = result.status;
    invoice.providerReference = result.reference;
    invoice.updatedAt = now();
    this.invoices.save(invoice);
    this.applyInvoiceOutcome(subscription, result.status, invoice.id);
    return invoice;
  }

  createInvoice(subscription: Subscription): Invoice {
    const invoice: Invoice = {
      id: `inv_${randomUUID()}`, subscriptionId: subscription.id, customerId: subscription.customerId,
      amount: subscription.price, currency: 'USD', status: 'pending', idempotencyKey: `charge:${subscription.id}:${randomUUID()}`,
      createdAt: now(), updatedAt: now()
    };
    this.invoices.save(invoice);
    return invoice;
  }

  applyInvoiceOutcome(subscription: Subscription, outcome: 'succeeded' | 'failed', invoiceId?: string): void {
    const trigger = outcome === 'succeeded' ? 'payment_succeeded' : 'payment_failed';
    try {
      const next = this.lifecycle.transition(subscription.status, trigger);
      this.move(subscription, next, `payment.${outcome}`, invoiceId);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'INVALID_TRANSITION') throw error;
    }
  }

  private move(subscription: Subscription, next: Subscription['status'], type: string, referenceId?: string): void {
    const previous = subscription.status;
    subscription.status = next;
    subscription.updatedAt = now();
    this.subscriptions.save(subscription);
    this.recordAudit(subscription, type, previous, next, referenceId);
  }

  recordAudit(subscription: Subscription, type: string, from?: Subscription['status'], to?: Subscription['status'], referenceId?: string): void {
    const event: AuditEvent = { id: `aud_${randomUUID()}`, subscriptionId: subscription.id, type, from, to, referenceId, createdAt: now() };
    this.audit.save(event);
  }
}

export class WebhookService {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly invoices: InvoiceRepository,
    private readonly events: WebhookEventRepository,
    private readonly audit: AuditEventRepository,
    private readonly subscriptionService: SubscriptionService
  ) {}

  process(payload: WebhookPayload): { duplicate: boolean } {
    const receivedAt = now();
    if (this.events.has(payload.event_id)) {
      this.events.recordDuplicate({ eventId: payload.event_id, type: payload.type, subscriptionId: payload.subscription_id, invoiceId: payload.invoice_id, disposition: 'duplicate', receivedAt });
      return { duplicate: true };
    }

    const invoice = this.invoices.findById(payload.invoice_id);
    const subscription = this.subscriptions.findById(payload.subscription_id);
    if (!invoice || !subscription || invoice.subscriptionId !== subscription.id) {
      this.events.save({ eventId: payload.event_id, type: payload.type, subscriptionId: payload.subscription_id, invoiceId: payload.invoice_id, disposition: 'rejected', receivedAt });
      throw new DomainError('UNKNOWN_REFERENCE', 'Unknown subscription or invoice', 404);
    }
    if (payload.amount !== invoice.amount || payload.currency !== invoice.currency) {
      this.events.save({ eventId: payload.event_id, type: payload.type, subscriptionId: payload.subscription_id, invoiceId: payload.invoice_id, disposition: 'rejected', receivedAt });
      throw new DomainError('PAYMENT_MISMATCH', 'Webhook amount or currency does not match invoice');
    }

    this.events.save({ eventId: payload.event_id, type: payload.type, subscriptionId: payload.subscription_id, invoiceId: payload.invoice_id, disposition: 'processed', receivedAt });
    if (payload.type === 'payment.refunded') {
      if (invoice.status === 'succeeded' || invoice.status === 'refunded') {
        if (invoice.status === 'succeeded') { invoice.status = 'refunded'; invoice.updatedAt = now(); this.invoices.save(invoice); }
        this.subscriptionService.recordAudit(subscription, 'payment.refunded', undefined, undefined, invoice.id);
      }
      return { duplicate: false };
    }

    const outcome = payload.type === 'payment.succeeded' ? 'succeeded' : 'failed';
    if (invoice.status === 'succeeded' || invoice.status === 'refunded' || invoice.status === 'failed' && outcome === 'failed') {
      return { duplicate: false };
    }
    invoice.status = outcome;
    if (outcome === 'succeeded') invoice.providerReference ??= `webhook:${payload.event_id}`;
    invoice.updatedAt = now();
    this.invoices.save(invoice);
    this.subscriptionService.applyInvoiceOutcome(subscription, outcome, invoice.id);
    return { duplicate: false };
  }
}
