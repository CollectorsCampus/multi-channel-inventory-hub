import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { CredentialStore } from '../src/connectors/credential-store.service';
import { InboundQueue } from '../src/queue/inbound-queue.service';
import { NEST_APP_OPTIONS, configureApp } from '../src/bootstrap';

/**
 * Webhook ingress, end to end over HTTP.
 *
 * This file exists because the boot smoke test's two ingress cases could not
 * fail. Both asserted only that a delivery was *rejected* — `not 403`, and
 * `>= 400` — and the harness built the app without `rawBody`, so every request
 * died at "Missing request body" before reaching `verifyWebhook` at all. Two
 * green tests, and the entire success path unexercised.
 *
 * So the assertions here are the other way round: a correctly signed delivery
 * must be **accepted**, persisted and queued. That is the case that breaks if
 * the raw body is re-serialized, if the app is built without `rawBody`, or if
 * the signing secret is not what we believe.
 *
 * The signature is computed from Shopify's own documented algorithm —
 * `base64(HMAC-SHA256(raw_body, client_secret))`, per
 * shopify.dev/docs/apps/build/webhooks/verify-deliveries — written out here
 * independently rather than by calling our own verifier's internals. A test
 * that reuses the implementation's own construction proves only that it agrees
 * with itself.
 */

const CLIENT_SECRET = 'test_client_secret_2f9c';
const EXPLICIT_WEBHOOK_SECRET = 'test_webhook_secret_a71b';
const CHANNEL_ID = 'chan_shopify_test';

/** Shopify's documented signing algorithm, stated independently of our code. */
function shopifySignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(Buffer.from(rawBody, 'utf8')).digest('base64');
}

let app: NestFastifyApplication;
let secrets: Record<string, string> = { clientSecret: CLIENT_SECRET };

const enqueue = vi.fn();
const webhookEventCreate = vi.fn().mockResolvedValue({ id: 'evt_1' });
const webhookEventFindUnique = vi.fn().mockResolvedValue(null);

const prismaStub = {
  $connect: vi.fn(),
  $disconnect: vi.fn(),
  user: { count: vi.fn().mockResolvedValue(0) },
  setting: { findFirst: vi.fn().mockResolvedValue(null) },
  session: { findUnique: vi.fn().mockResolvedValue(null) },
  apiKey: { findUnique: vi.fn().mockResolvedValue(null) },
  channelInstance: {
    findUnique: vi.fn().mockImplementation(async () => ({
      id: CHANNEL_ID,
      connectorKey: 'shopify',
      displayName: 'Test Shop',
      enabled: true,
      credentialRef: 'cred_1',
      // config is a String column holding JSON (ADR 0001 §2).
      config: JSON.stringify({
        shopDomain: 'test-store.myshopify.com',
        clientId: 'test-client-id',
        locationId: 'gid://shopify/Location/1',
      }),
    })),
  },
  webhookEvent: {
    findUnique: webhookEventFindUnique,
    create: webhookEventCreate,
  },
};

/** A minimal but realistically shaped `orders/create` body. */
const ORDER_BODY = JSON.stringify({
  id: 5432109876,
  admin_graphql_api_id: 'gid://shopify/Order/5432109876',
  name: '#1001',
  created_at: '2026-07-29T10:00:00-04:00',
  line_items: [
    {
      id: 111,
      admin_graphql_api_variant_id: 'gid://shopify/ProductVariant/999',
      quantity: 2,
    },
  ],
});

function post(body: string, headers: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: `/api/webhooks/${CHANNEL_ID}`,
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': 'orders/create',
      ...headers,
    },
  });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prismaStub)
    .overrideProvider(CredentialStore)
    .useValue({ get: vi.fn().mockImplementation(async () => secrets) })
    .overrideProvider(InboundQueue)
    .useValue({ enqueue })
    .compile();

  // NEST_APP_OPTIONS rather than a literal: passing `{ rawBody: true }` by hand
  // here is exactly the duplication that let production and the tests diverge.
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    NEST_APP_OPTIONS,
  );
  await configureApp(app, { sessionSecret: Buffer.alloc(32, 3).toString('base64') });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(() => {
  vi.clearAllMocks();
  webhookEventFindUnique.mockResolvedValue(null);
  webhookEventCreate.mockResolvedValue({ id: 'evt_1' });
  secrets = { clientSecret: CLIENT_SECRET };
});

afterAll(async () => {
  await app?.close();
});

describe('webhook ingress', () => {
  /**
   * The assumption the whole client-credentials rework rests on: Shopify signs
   * an app's webhooks with that app's client secret, and `verifyWebhook` falls
   * back to it when no explicit `webhookSecret` is configured. If this is
   * wrong, every real delivery is silently rejected.
   */
  it('accepts a delivery signed with the client secret when no webhookSecret is set', async () => {
    const res = await post(ORDER_BODY, {
      'x-shopify-hmac-sha256': shopifySignature(ORDER_BODY, CLIENT_SECRET),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(webhookEventCreate).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('evt_1');
  });

  it('stores the delivery with its topic and byte-exact body', async () => {
    await post(ORDER_BODY, {
      'x-shopify-hmac-sha256': shopifySignature(ORDER_BODY, CLIENT_SECRET),
    });

    const { data } = webhookEventCreate.mock.calls[0]![0] as {
      data: { topic: string; body: string; status: string };
    };
    expect(data.topic).toBe('orders/create');
    expect(data.body).toBe(ORDER_BODY);
    expect(data.status).toBe('received');
  });

  /**
   * The raw-body guarantee, stated as a property rather than a configuration
   * flag. This body is valid JSON that `JSON.parse` → `JSON.stringify` would
   * silently rewrite: padded whitespace, and keys out of insertion order. If
   * anything in the stack hands `verifyWebhook` a re-serialized body, the HMAC
   * is computed over different bytes and this fails — which is the failure that
   * would otherwise only appear against a live store.
   */
  it('verifies against the bytes as sent, not a re-serialized body', async () => {
    const quirky = '{ "b" : 2,\n  "a"  :  1,\t"line_items" : [] }';

    const res = await post(quirky, {
      'x-shopify-hmac-sha256': shopifySignature(quirky, CLIENT_SECRET),
    });

    expect(res.statusCode).toBe(200);
    // Proves the point directly: the stored body still has the original
    // spacing, so nothing normalized it on the way through.
    const { data } = webhookEventCreate.mock.calls[0]![0] as { data: { body: string } };
    expect(data.body).toBe(quirky);
  });

  it('rejects a body altered after signing', async () => {
    const signature = shopifySignature(ORDER_BODY, CLIENT_SECRET);
    const tampered = ORDER_BODY.replace('"quantity":2', '"quantity":99');

    const res = await post(tampered, { 'x-shopify-hmac-sha256': signature });

    expect(res.statusCode).toBe(401);
    expect(webhookEventCreate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a signature made with the wrong secret', async () => {
    const res = await post(ORDER_BODY, {
      'x-shopify-hmac-sha256': shopifySignature(ORDER_BODY, 'not-the-secret'),
    });

    expect(res.statusCode).toBe(401);
    expect(webhookEventCreate).not.toHaveBeenCalled();
  });

  it('rejects a delivery carrying no signature at all', async () => {
    const res = await post(ORDER_BODY, {});

    expect(res.statusCode).toBe(401);
    expect(webhookEventCreate).not.toHaveBeenCalled();
  });

  /** A malformed signature must fail closed, not throw — timingSafeEqual
   * throws on a length mismatch, so the length check in front of it is load
   * bearing. A 500 here would be an unauthenticated crash. */
  it('rejects a malformed signature without erroring', async () => {
    const res = await post(ORDER_BODY, { 'x-shopify-hmac-sha256': 'not-base64-at-all!!' });

    expect(res.statusCode).toBe(401);
  });

  /**
   * An explicit webhookSecret still wins, for a subscription created by hand
   * with a secret of its own. The client secret must then *not* be accepted —
   * otherwise the explicit value is decorative.
   */
  describe('with an explicit webhookSecret', () => {
    it('accepts the explicit secret and refuses the client secret', async () => {
      secrets = { clientSecret: CLIENT_SECRET, webhookSecret: EXPLICIT_WEBHOOK_SECRET };

      const accepted = await post(ORDER_BODY, {
        'x-shopify-hmac-sha256': shopifySignature(ORDER_BODY, EXPLICIT_WEBHOOK_SECRET),
      });
      expect(accepted.statusCode).toBe(200);

      const refused = await post(ORDER_BODY, {
        'x-shopify-hmac-sha256': shopifySignature(ORDER_BODY, CLIENT_SECRET),
      });
      expect(refused.statusCode).toBe(401);
    });
  });

  /**
   * Shopify redelivers routinely. A redelivery is byte-identical, so the body
   * hash matches an existing row and the work must not be queued twice — but
   * the response must still be 200, or the platform keeps retrying.
   */
  it('answers 200 to a redelivery without queueing it again', async () => {
    webhookEventFindUnique.mockResolvedValue({ id: 'evt_1' });

    const res = await post(ORDER_BODY, {
      'x-shopify-hmac-sha256': shopifySignature(ORDER_BODY, CLIENT_SECRET),
    });

    expect(res.statusCode).toBe(200);
    expect(webhookEventCreate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
