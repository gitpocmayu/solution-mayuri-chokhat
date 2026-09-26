import { Plan, PlanCode } from './domain';

export class PlanFactory {
  private readonly plans: Record<PlanCode, Plan> = {
    basic: { code: 'basic', price: 1200, trialDays: 7, currency: 'USD', chargeImmediately: false },
    pro: { code: 'pro', price: 4900, trialDays: 14, currency: 'USD', chargeImmediately: false }
  };

  constructor(overrides: Partial<Record<PlanCode, Partial<Plan>>> = {}) {
    for (const code of ['basic', 'pro'] as const) {
      this.plans[code] = { ...this.plans[code], ...overrides[code] };
    }
  }

  get(code: unknown): Plan {
    if (code !== 'basic' && code !== 'pro') throw new Error('Unknown plan');
    return { ...this.plans[code] };
  }
}
