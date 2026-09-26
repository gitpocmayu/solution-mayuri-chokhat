import { expect } from '@jest/globals';
import { Invoice, Subscription } from '../../src/domain';
import { MockPaymentProvider } from '../../src/payment-provider';
import { SubscriptionTestEnvironment } from './environment';

export function expectProviderCalledOnceWith(provider: MockPaymentProvider, expected: { customerId: string; amount: number; paymentMethodId: string }) {
  expect(provider.calls).toHaveLength(1);
  expect(provider.calls[0]).toEqual(expect.objectContaining(expected));
  expect(provider.calls[0].idempotencyKey).toMatch(/^charge:sub_/);
}

export function expectSubscriptionPersisted(environment: SubscriptionTestEnvironment, apiSubscription: Subscription) {
  expect(environment.subscriptions.findById(apiSubscription.id)).toEqual(apiSubscription);
}

export function expectInvoicePersisted(invoice: Invoice, environment: SubscriptionTestEnvironment, status: Invoice['status']) {
  expect(environment.invoices.findById(invoice.id)).toEqual(expect.objectContaining({ id: invoice.id, status, amount: invoice.amount }));
}
