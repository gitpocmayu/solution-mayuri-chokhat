import { randomUUID } from 'node:crypto';

export interface ChargeRequest {
  customerId: string;
  amount: number;
  currency: string;
  paymentMethodId: string;
  idempotencyKey: string;
}
export type ChargeOutcome = 'success' | 'decline' | 'timeout';
export interface ChargeResult {
  status: 'succeeded' | 'failed';
  reference: string;
  reason?: 'declined' | 'timeout';
}
export interface PaymentProvider {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly calls: ChargeRequest[] = [];
  private readonly outcomes: ChargeOutcome[] = [];

  queueOutcome(outcome: ChargeOutcome): void { this.outcomes.push(outcome); }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.calls.push({ ...request });
    const outcome = this.outcomes.shift() ?? 'success';
    if (outcome === 'success') return { status: 'succeeded', reference: `pay_${randomUUID()}` };
    return { status: 'failed', reference: `pay_${randomUUID()}`, reason: outcome === 'timeout' ? 'timeout' : 'declined' };
  }
}
