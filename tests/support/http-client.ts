import request from 'supertest';
import { Express } from 'express';
import { signWebhook } from '../../src/app';
import { PlanCode, Subscription, WebhookPayload } from '../../src/domain';

export class SubscriptionApiClient {
  constructor(private readonly app: Express, private readonly secret: string) {}

  createSubscription(body: object) { return request(this.app).post('/subscriptions').send(body); }
  getSubscription(id: string) { return request(this.app).get(`/subscriptions/${id}`); }
  changePlan(id: string, plan: PlanCode) { return request(this.app).patch(`/subscriptions/${id}/plan`).send({ plan }); }
  cancelSubscription(id: string) { return request(this.app).post(`/subscriptions/${id}/cancel`); }
  sendWebhook(payload: WebhookPayload, signature?: string) {
    const raw = JSON.stringify(payload);
    return request(this.app).post('/webhooks/payment-provider').set('Content-Type', 'application/json')
      .set('X-Provider-Signature', signature ?? signWebhook(raw, this.secret)).send(raw);
  }
  sendRawWebhook(raw: string, signature?: string) {
    return request(this.app).post('/webhooks/payment-provider').set('Content-Type', 'application/json')
      .set('X-Provider-Signature', signature ?? signWebhook(raw, this.secret)).send(raw);
  }
  async createValidSubscription(plan: 'basic' | 'pro' = 'pro'): Promise<Subscription> {
    const response = await this.createSubscription({ customer_id: 'cust_001', plan, payment_method_id: 'pm_test_visa_4242' });
    if (response.status !== 201) throw new Error(`Subscription setup failed: ${response.status}`);
    return response.body as Subscription;
  }
}
