import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { ConfigService } from '@nestjs/config';
import { createShopifyConnector } from '@hub/connector-shopify';
import { ChannelsService } from './channels.service';
import { validateChannelConfig, pickSchemaFields } from './config-schema';
import { ConnectorRegistry } from '../connectors/connector-registry.service';
import { CredentialStore } from '../connectors/credential-store.service';
import type { PrismaService } from '../prisma/prisma.service';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const MASTER_KEY = Buffer.alloc(32, 0x5a).toString('base64');

const SHOPIFY_CONFIG = {
  shopDomain: 'my-store.myshopify.com',
  locationId: 'gid://shopify/Location/1',
};

describe('config schema validation', () => {
  const schema = createShopifyConnector().configSchema;

  it('accepts a complete configuration', () => {
    expect(validateChannelConfig(schema, SHOPIFY_CONFIG)).toEqual([]);
  });

  it('reports each missing required field by its human title', () => {
    const issues = validateChannelConfig(schema, {});
    expect(issues.map((i) => i.field).sort()).toEqual(['locationId', 'shopDomain']);
    expect(issues[0]!.message).toMatch(/required/);
  });

  it('enforces a connector-declared pattern', () => {
    const issues = validateChannelConfig(schema, {
      ...SHOPIFY_CONFIG,
      shopDomain: 'not-a-shopify-domain.example.com',
    });
    expect(issues.map((i) => i.field)).toEqual(['shopDomain']);
  });

  it('treats an empty string as absent rather than valid', () => {
    const issues = validateChannelConfig(schema, { ...SHOPIFY_CONFIG, shopDomain: '' });
    expect(issues.map((i) => i.field)).toContain('shopDomain');
  });

  /**
   * A connector upgrade that drops a setting must not lock an operator out of
   * their own channel, so unknown keys are dropped rather than rejected.
   */
  it('drops keys the schema does not declare', () => {
    expect(pickSchemaFields(schema, { ...SHOPIFY_CONFIG, sneaky: 'value' })).toEqual(
      SHOPIFY_CONFIG,
    );
  });

  it('does not crash on a malformed pattern in a connector schema', () => {
    const broken = { type: 'object', properties: { x: { type: 'string', pattern: '[' } } };
    const issues = validateChannelConfig(broken, { x: 'anything' });
    expect(issues[0]?.message).toMatch(/invalid validation rule/);
  });
});

describeDb('ChannelsService', () => {
  let prisma: PrismaClient;
  let service: ChannelsService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();

    const registry = new ConnectorRegistry();
    registry.register(createShopifyConnector());

    const credentials = new CredentialStore(
      prisma as unknown as PrismaService,
      {
        getOrThrow: () => MASTER_KEY,
      } as unknown as ConfigService,
    );

    service = new ChannelsService(prisma as unknown as PrismaService, registry, credentials);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.channelAllocation.deleteMany();
    await prisma.channelInstance.deleteMany();
    await prisma.credential.deleteMany();
    await prisma.inventoryItem.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.catalogItem.deleteMany();
  });

  const create = () =>
    service.create({
      connectorKey: 'shopify',
      displayName: 'My Store',
      config: SHOPIFY_CONFIG,
      secrets: { accessToken: 'shpat_secret', webhookSecret: 'whsec' },
    });

  it('creates a channel and reports its webhook endpoint', async () => {
    const channel = await create();

    expect(channel.displayName).toBe('My Store');
    expect(channel.config).toEqual(SHOPIFY_CONFIG);
    expect(channel.syncMode).toBe('continuous');
    // The operator needs this to configure the platform side.
    expect(channel.webhookPath).toBe(`/api/webhooks/${channel.id}`);
  });

  /**
   * The central rule: a stored secret grants control of a live storefront, so
   * it goes in and never comes out.
   */
  it('never returns secret values, only which fields are set', async () => {
    const channel = await create();

    expect(channel.secretsSet.sort()).toEqual(['accessToken', 'webhookSecret']);
    expect(JSON.stringify(channel)).not.toContain('shpat_secret');
    expect(JSON.stringify(channel)).not.toContain('whsec');

    const listed = await service.list();
    expect(JSON.stringify(listed)).not.toContain('shpat_secret');
  });

  it('rejects an incomplete configuration', async () => {
    await expect(
      service.create({
        connectorKey: 'shopify',
        displayName: 'Broken',
        config: { shopDomain: 'my-store.myshopify.com' },
      }),
    ).rejects.toThrow(/incomplete/);

    expect(await prisma.channelInstance.count()).toBe(0);
  });

  it('rejects secrets the connector never declared', async () => {
    await expect(
      service.create({
        connectorKey: 'shopify',
        displayName: 'Odd',
        config: SHOPIFY_CONFIG,
        secrets: { somethingElse: 'x' },
      }),
    ).rejects.toThrow(/does not use: somethingElse/);
  });

  it('rejects an unregistered connector', async () => {
    await expect(
      service.create({ connectorKey: 'nope', displayName: 'X', config: {} }),
    ).rejects.toThrow(/No connector registered/);
  });

  describe('updates', () => {
    it('merges config rather than replacing it', async () => {
      const channel = await create();

      // The form submits only what it renders; a partial save must not clear
      // the rest.
      const updated = await service.update(channel.id, {
        config: { locationId: 'gid://shopify/Location/2' },
      });

      expect(updated.config).toEqual({
        shopDomain: SHOPIFY_CONFIG.shopDomain,
        locationId: 'gid://shopify/Location/2',
      });
    });

    it('rejects an update that would leave the config invalid', async () => {
      const channel = await create();
      await expect(service.update(channel.id, { config: { shopDomain: 'bad' } })).rejects.toThrow(
        /incomplete/,
      );
    });

    it('replaces one secret without disturbing the others', async () => {
      const channel = await create();

      await service.update(channel.id, { secrets: { accessToken: 'shpat_rotated' } });

      const after = await service.get(channel.id);
      expect(after.secretsSet.sort()).toEqual(['accessToken', 'webhookSecret']);
    });

    it('toggles enabled', async () => {
      const channel = await create();
      expect((await service.update(channel.id, { enabled: false })).enabled).toBe(false);
      expect((await service.update(channel.id, { enabled: true })).enabled).toBe(true);
    });
  });

  describe('deletion', () => {
    it('removes the channel and its stored credentials', async () => {
      const channel = await create();
      await service.remove(channel.id);

      expect(await prisma.channelInstance.count()).toBe(0);
      // Orphaned ciphertext would linger indefinitely otherwise.
      expect(await prisma.credential.count()).toBe(0);
    });

    /**
     * Cascading would silently delete per-channel quantities and prices.
     * Returning that stock to the pool is a decision the operator makes.
     */
    it('refuses while allocations still reference it', async () => {
      const channel = await create();

      const catalogItem = await prisma.catalogItem.create({
        data: {
          name: 'Card',
          searchName: 'card',
          skus: { create: [{ condition: 'NM', printing: 'NORMAL', language: 'EN' }] },
        },
        include: { skus: true },
      });
      const item = await prisma.inventoryItem.create({
        data: { skuId: catalogItem.skus[0]!.id, quantityOnHand: 5 },
      });
      await prisma.channelAllocation.create({
        data: { inventoryItemId: item.id, channelInstanceId: channel.id, mode: 'pooled' },
      });

      await expect(service.remove(channel.id)).rejects.toThrow(/still has 1 allocation/);
      expect(await prisma.channelInstance.count()).toBe(1);
    });
  });

  /**
   * A channel can outlive its connector — a downgrade, or a community connector
   * removed from the deployment. That must be reported, not thrown.
   */
  it('reports a channel whose connector is no longer registered', async () => {
    await prisma.channelInstance.create({
      data: { connectorKey: 'vanished', displayName: 'Old Channel', config: '{}' },
    });

    const [channel] = await service.list();
    expect(channel!.healthStatus).toBe('error');
    expect(channel!.healthDetail).toMatch(/No connector registered/);
    expect(channel!.webhookPath).toBeNull();
  });
});
