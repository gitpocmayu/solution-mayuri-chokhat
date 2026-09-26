import express, { NextFunction, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError, WebhookPayload } from './domain';
import { SubscriptionService, WebhookService } from './services';

export interface AppDependencies {
  subscriptionService: SubscriptionService;
  webhookService: WebhookService;
  webhookSecret: string;
}

export const signWebhook = (rawBody: Buffer | string, secret: string): string =>
  createHmac('sha256', secret).update(rawBody).digest('hex');

const validPayload = (value: unknown): value is WebhookPayload => {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return typeof body.event_id === 'string' && body.event_id.length > 0 &&
    ['payment.succeeded', 'payment.failed', 'payment.refunded'].includes(String(body.type)) &&
    typeof body.subscription_id === 'string' && typeof body.invoice_id === 'string' &&
    Number.isInteger(body.amount) && typeof body.currency === 'string';
};

export function createApp(dependencies: AppDependencies) {
  const app = express();
  app.use(express.json({ verify: (request, _response, buffer) => { (request as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer); } }));

  app.post('/subscriptions', async (request, response, next) => {
    try {
      const subscription = await dependencies.subscriptionService.create(request.body ?? {});
      response.status(201).json(subscription);
    } catch (error) { next(error); }
  });

  app.get('/subscriptions/:id', (request, response, next) => {
    try { response.json(dependencies.subscriptionService.get(request.params.id)); }
    catch (error) { next(error); }
  });

  app.patch('/subscriptions/:id/plan', (request, response, next) => {
    try { response.json(dependencies.subscriptionService.changePlan(request.params.id, request.body?.plan)); }
    catch (error) { next(error); }
  });

  app.post('/subscriptions/:id/cancel', (request, response, next) => {
    try { response.json(dependencies.subscriptionService.cancel(request.params.id)); }
    catch (error) { next(error); }
  });

  app.post('/webhooks/payment-provider', (request, response, next) => {
    try {
      const signature = request.header('X-Provider-Signature');
      if (!signature) throw new DomainError('SIGNATURE_REQUIRED', 'Webhook signature is required', 401);
      const rawBody = (request as Request & { rawBody?: Buffer }).rawBody;
      if (!rawBody) throw new DomainError('INVALID_SIGNATURE', 'Webhook signature is invalid', 401);
      const expected = Buffer.from(signWebhook(rawBody, dependencies.webhookSecret), 'hex');
      let supplied: Buffer;
      try { supplied = Buffer.from(signature, 'hex'); } catch { supplied = Buffer.alloc(0); }
      if (!/^[a-f0-9]{64}$/i.test(signature) || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new DomainError('INVALID_SIGNATURE', 'Webhook signature is invalid', 401);
      if (!validPayload(request.body)) throw new DomainError('MALFORMED_WEBHOOK', 'Webhook payload is malformed');
      response.json(dependencies.webhookService.process(request.body));
    } catch (error) { next(error); }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof SyntaxError) {
      response.status(400).json({ error: { code: 'MALFORMED_JSON', message: 'Request body is not valid JSON' } });
      return;
    }
    if (error instanceof DomainError) {
      response.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
      return;
    }
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected service error' } });
  });
  return app;
}
