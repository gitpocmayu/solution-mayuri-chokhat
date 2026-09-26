import { Customer, PlanCode, WebhookPayload } from '../../src/domain';

export class CustomerBuilder {
  private id = 'cust_001';
  withId(id: string): this { this.id = id; return this; }
  build(): Customer { return { id: this.id }; }
}

export class SubscriptionBuilder {
  private customerId = 'cust_001';
  private plan: PlanCode = 'pro';
  private paymentMethodId = 'pm_test_visa_4242';
  withCustomer(customer: Customer): this { this.customerId = customer.id; return this; }
  withPlan(plan: PlanCode): this { this.plan = plan; return this; }
  withPaymentMethod(id: string): this { this.paymentMethodId = id; return this; }
  withCustomerId(id: string): this { this.customerId = id; return this; }
  build() { return { customer_id: this.customerId, plan: this.plan, payment_method_id: this.paymentMethodId }; }
}

export class WebhookEventBuilder {
  private payload: WebhookPayload = {
    event_id: 'evt_001', type: 'payment.succeeded', subscription_id: 'sub_unknown',
    invoice_id: 'inv_unknown', amount: 4900, currency: 'USD'
  };
  with(patch: Partial<WebhookPayload>): this { this.payload = { ...this.payload, ...patch }; return this; }
  build(): WebhookPayload { return { ...this.payload }; }
}
