import { beforeEach, describe, expect, it } from 'vitest';
import type { Connector } from '@hub/connector-sdk';
import { ConnectorRegistry } from './connector-registry.service';
import { redactSecrets } from './channel-context.service';

function connector(overrides: Partial<Connector> = {}): Connector {
  return {
    key: 'example',
    displayName: 'Example',
    configSchema: { type: 'object', properties: {} },
    capabilities: [],
    ...overrides,
  };
}

describe('ConnectorRegistry', () => {
  let registry: ConnectorRegistry;

  beforeEach(() => {
    registry = new ConnectorRegistry();
  });

  it('registers and resolves a connector by key', () => {
    const c = connector();
    registry.register(c);

    expect(registry.has('example')).toBe(true);
    expect(registry.get('example')).toBe(c);
  });

  /**
   * The registry is the only point at which the core can check a connector
   * before trusting it, which matters most for community connectors.
   */
  it('refuses a connector whose declarations and methods disagree', () => {
    expect(() => registry.register(connector({ capabilities: ['listing.quantity'] }))).toThrow(
      /updateQuantity/,
    );
    expect(registry.has('example')).toBe(false);
  });

  it('refuses two connectors claiming the same key', () => {
    registry.register(connector());
    expect(() => registry.register(connector({ displayName: 'Impostor' }))).toThrow(
      /both claim the key/,
    );
  });

  it('names the registered keys when a lookup misses', () => {
    registry.register(connector({ key: 'shopify' }));
    expect(() => registry.get('tcgplayer')).toThrow(/Registered: shopify/);
  });

  it('says so plainly when nothing is registered', () => {
    expect(() => registry.get('shopify')).toThrow(/Registered: none/);
  });

  /**
   * The engine branches on this before dispatching — a connector without
   * `orders.webhook` gets polled instead, and one with neither is manual.
   */
  it('answers capability questions without the caller touching the connector', () => {
    registry.register(
      connector({
        key: 'filebased',
        capabilities: ['listing.export', 'orders.import'],
        exportListings: async () => ({
          filename: 'x.csv',
          contentType: 'text/csv',
          content: Buffer.alloc(0),
        }),
        importOrders: async () => ({ records: [], problems: [] }),
      }),
    );

    expect(registry.supports('filebased', 'orders.import')).toBe(true);
    expect(registry.supports('filebased', 'orders.webhook')).toBe(false);
    // An unknown connector supports nothing, rather than throwing — callers
    // ask this to decide whether to dispatch at all.
    expect(registry.supports('nope', 'orders.import')).toBe(false);
  });

  it('summarises connectors for the channel picker, including derived sync mode', () => {
    registry.register(
      connector({
        key: 'filebased',
        displayName: 'File Based',
        capabilities: ['orders.import'],
        secretFields: ['apiToken'],
        importOrders: async () => ({ records: [], problems: [] }),
      }),
    );

    expect(registry.list()).toEqual([
      expect.objectContaining({
        key: 'filebased',
        displayName: 'File Based',
        syncMode: 'manual',
        secretFields: ['apiToken'],
      }),
    ]);
  });
});

describe('log redaction', () => {
  it('scrubs values whose keys look sensitive', () => {
    // Connector authors are told not to log secrets; this is what happens when
    // one does anyway.
    expect(
      redactSecrets({
        shopDomain: 'example.myshopify.com',
        accessToken: 'shpat_verysecret',
        apiKey: 'abc123',
        webhook_secret: 'hunter2',
        password: 'hunter2',
        quantity: 5,
      }),
    ).toEqual({
      shopDomain: 'example.myshopify.com',
      accessToken: '[redacted]',
      apiKey: '[redacted]',
      webhook_secret: '[redacted]',
      password: '[redacted]',
      quantity: 5,
    });
  });

  it('leaves ordinary operational metadata alone', () => {
    const meta = { listingId: 'gid://shopify/x', attempt: 2, durationMs: 130 };
    expect(redactSecrets(meta)).toEqual(meta);
  });
});
