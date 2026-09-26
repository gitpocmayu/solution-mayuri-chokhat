import { AuditEvent, Customer, Invoice, Subscription, WebhookEvent } from './domain';

export interface CustomerRepository {
  save(customer: Customer): void;
  findById(id: string): Customer | undefined;
}

export interface SubscriptionRepository {
  save(subscription: Subscription): void;
  findById(id: string): Subscription | undefined;
  all(): Subscription[];
}
export interface InvoiceRepository {
  save(invoice: Invoice): void;
  findById(id: string): Invoice | undefined;
  all(): Invoice[];
}
export interface WebhookEventRepository {
  has(eventId: string): boolean;
  save(event: WebhookEvent): void;
  recordDuplicate(event: WebhookEvent): void;
  all(): WebhookEvent[];
}
export interface AuditEventRepository {
  save(event: AuditEvent): void;
  forSubscription(subscriptionId: string): AuditEvent[];
}

export class InMemoryCustomerRepository implements CustomerRepository {
  private readonly rows = new Map<string, Customer>();
  save(value: Customer): void { this.rows.set(value.id, { ...value }); }
  findById(id: string): Customer | undefined { const value = this.rows.get(id); return value && { ...value }; }
}

export class InMemorySubscriptionRepository implements SubscriptionRepository {
  private readonly rows = new Map<string, Subscription>();
  save(value: Subscription): void { this.rows.set(value.id, { ...value }); }
  findById(id: string): Subscription | undefined { const value = this.rows.get(id); return value && { ...value }; }
  all(): Subscription[] { return [...this.rows.values()].map(value => ({ ...value })); }
}
export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly rows = new Map<string, Invoice>();
  save(value: Invoice): void { this.rows.set(value.id, { ...value }); }
  findById(id: string): Invoice | undefined { const value = this.rows.get(id); return value && { ...value }; }
  all(): Invoice[] { return [...this.rows.values()].map(value => ({ ...value })); }
}
export class InMemoryWebhookEventRepository implements WebhookEventRepository {
  private readonly rows = new Map<string, WebhookEvent>();
  private readonly deliveries: WebhookEvent[] = [];
  has(id: string): boolean { return this.rows.has(id); }
  save(value: WebhookEvent): void { this.rows.set(value.eventId, { ...value }); this.deliveries.push({ ...value }); }
  recordDuplicate(value: WebhookEvent): void { this.deliveries.push({ ...value }); }
  all(): WebhookEvent[] { return this.deliveries.map(value => ({ ...value })); }
}
export class InMemoryAuditEventRepository implements AuditEventRepository {
  private readonly rows: AuditEvent[] = [];
  save(value: AuditEvent): void { this.rows.push({ ...value }); }
  forSubscription(id: string): AuditEvent[] { return this.rows.filter(value => value.subscriptionId === id).map(value => ({ ...value })); }
}
