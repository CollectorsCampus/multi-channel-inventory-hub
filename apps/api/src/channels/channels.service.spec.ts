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
  clientId: 'dev-dashboard-client-id',
  locationId: 'gid://shopify/Location/1',
};

describe('config schema validation', () => {
  const schema = createShopifyConnector().configSchema;

  it('accepts a complete configuration', () => {
    expect(validateChannelConfig(schema, SHOPIFY_CONFIG)).toEqual([]);
  });

  it('reports each missing required field by its human title', () => {
    const issues = validateChannelConfig(schema, {});
    expect(issues.map((i) => i.field).sort()).toEqual(['clientId', 'locationId', 'shopDomain']);
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
      secrets: { clientSecret: 'shpss_secret', webhookSecret: 'whsec' },
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
   * `secretFieldsRequired` drives the "still needs: …" warning in the channel
   * UI, so an optional field listed there tells a working channel it is broken.
   *
   * That is not hypothetical: Shopify signs an app's webhooks with its client
   * secret, so `webhookSecret` is only for a subscription created by hand — and
   * a channel configured the normal way was permanently labelled "not connected
   * yet", which sent operators hunting the Shopify Dev Dashboard for a value it
   * does not issue.
   */
  it('requires only the secrets a channel cannot work without', async () => {
    const channel = await service.create({
      connectorKey: 'shopify',
      displayName: 'Client secret only',
      config: SHOPIFY_CONFIG,
      secrets: { clientSecret: 'shpss_secret' },
    });

    // Still offered for input — it has a real use — but not demanded.
    expect(channel.secretFieldsRequired).toEqual(['clientSecret']);
    expect(channel.secretFieldsRequired).not.toContain('webhookSecret');

    // Which is what makes the UI's "missing secrets" set empty for this channel.
    const missing = channel.secretFieldsRequired.filter(
      (field) => !channel.secretsSet.includes(field),
    );
    expect(missing).toEqual([]);
  });

  /**
   * The central rule: a stored secret grants control of a live storefront, so
   * it goes in and never comes out.
   */
  it('never returns secret values, only which fields are set', async () => {
    const channel = await create();

    expect(channel.secretsSet.sort()).toEqual(['clientSecret', 'webhookSecret']);
    expect(JSON.stringify(channel)).not.toContain('shpss_secret');
    expect(JSON.stringify(channel)).not.toContain('whsec');

    const listed = await service.list();
    expect(JSON.stringify(listed)).not.toContain('shpss_secret');
  });

  it('rejects an incomplete configuration', async () => {
    await expect(
      service.create({
        connectorKey: 'shopify',
        displayName: 'Broken',
        config: { shopDomain: 'my-store.myshopify.com', clientId: 'partial' },
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
        clientId: SHOPIFY_CONFIG.clientId,
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

      await service.update(channel.id, { secrets: { clientSecret: 'shpss_rotated' } });

      const after = await service.get(channel.id);
      expect(after.secretsSet.sort()).toEqual(['clientSecret', 'webhookSecret']);
    });

    it('toggles enabled', async () => {
      const channel = await create();
      expect((await service.update(channel.id, { enabled: false })).enabled).toBe(false);
      expect((await service.update(channel.id, { enabled: true })).enabled).toBe(true);
    });
  });

  /**
   * The gate on automatic listing.
   *
   * Creation applies tags and custom fields verbatim and the hub may never
   * derive one — on a store whose collections are all tag equality rules, a
   * guessed tag yields a product that is invisible in the shop and reported by
   * nothing. So the toggle is refused until the operator has said what a
   * created product should carry.
   */
  describe('automatic listing', () => {
    it('refuses the toggle while nothing has been declared', async () => {
      const channel = await create();

      await expect(service.update(channel.id, { autoListNewStock: true })).rejects.toThrow(
        /no listing defaults/i,
      );

      expect((await service.get(channel.id)).autoListNewStock).toBe(false);
    });

    /**
     * Declaring and enabling is one save in the settings form, so the check
     * must see what this request is writing rather than what is stored. Reading
     * the column instead would reject the only sensible way to turn it on.
     */
    it('accepts the toggle and the declaration in one update', async () => {
      const channel = await create();

      const updated = await service.update(channel.id, {
        autoListNewStock: true,
        listingDefaults: { tags: ['Pokémon'], vendor: 'The Pokémon Company' },
      });

      expect(updated.autoListNewStock).toBe(true);
      expect(updated.listingDefaults).toEqual({
        tags: ['Pokémon'],
        vendor: 'The Pokémon Company',
      });
    });

    it('accepts the toggle once defaults are already stored', async () => {
      const channel = await create();
      await service.update(channel.id, { listingDefaults: { tags: ['Pokémon'] } });

      expect((await service.update(channel.id, { autoListNewStock: true })).autoListNewStock).toBe(
        true,
      );
    });

    /**
     * "No tags" is a deliberate answer, and a store that organises by something
     * other than tags is entitled to give it. What the guard refuses is a
     * channel where nothing was ever said.
     */
    it('accepts an explicit "no tags" as having been declared', async () => {
      const channel = await create();

      const updated = await service.update(channel.id, {
        autoListNewStock: true,
        listingDefaults: { tags: [] },
      });

      expect(updated.autoListNewStock).toBe(true);
      expect(updated.listingDefaults.tags).toEqual([]);
    });

    /**
     * Wholesale, unlike `config` above. Merging would make removing the last
     * tag impossible — the form would submit `{tags: []}` and get back what it
     * was trying to clear.
     */
    it('replaces the declaration rather than merging it', async () => {
      const channel = await create();
      await service.update(channel.id, {
        listingDefaults: { tags: ['Pokémon'], vendor: 'The Pokémon Company' },
      });

      const updated = await service.update(channel.id, { listingDefaults: { tags: [] } });

      expect(updated.listingDefaults).toEqual({ tags: [] });
    });

    it('refuses to clear the declaration out from under an enabled toggle', async () => {
      const channel = await create();
      await service.update(channel.id, {
        autoListNewStock: true,
        listingDefaults: { tags: ['Pokémon'] },
      });

      await expect(service.update(channel.id, { listingDefaults: {} })).rejects.toThrow(
        /no listing defaults/i,
      );

      expect((await service.get(channel.id)).listingDefaults.tags).toEqual(['Pokémon']);
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
