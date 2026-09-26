export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';
export type PlanCode = 'basic' | 'pro';
export type InvoiceStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';
export type WebhookType = 'payment.succeeded' | 'payment.failed' | 'payment.refunded';

export interface Plan {
  code: PlanCode;
  price: number;
  trialDays: number;
  currency: 'USD';
  chargeImmediately: boolean;
}

export interface Customer {
  id: string;
}

export interface Subscription {
  id: string;
  customerId: string;
  plan: PlanCode;
  price: number;
  trialDays: number;
  paymentMethodId: string;
  status: SubscriptionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Invoice {
  id: string;
  subscriptionId: string;
  customerId: string;
  amount: number;
  currency: string;
  status: InvoiceStatus;
  idempotencyKey: string;
  providerReference?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEvent {
  eventId: string;
  type: string;
  subscriptionId?: string;
  invoiceId?: string;
  disposition: 'processed' | 'duplicate' | 'rejected';
  receivedAt: string;
}

export interface AuditEvent {
  id: string;
  subscriptionId: string;
  type: string;
  from?: SubscriptionStatus;
  to?: SubscriptionStatus;
  referenceId?: string;
  createdAt: string;
}

export interface WebhookPayload {
  event_id: string;
  type: WebhookType;
  subscription_id: string;
  invoice_id: string;
  amount: number;
  currency: string;
}

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'DomainError';
  }
}
