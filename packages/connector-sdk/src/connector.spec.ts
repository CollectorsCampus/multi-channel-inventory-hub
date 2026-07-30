import { describe, expect, it } from 'vitest';
import {
  assertValidConnector,
  connectorSyncMode,
  validateConnector,
  type Connector,
} from './connector';
import { CAPABILITIES, CAPABILITY_METHODS, isManualChannel, syncModeOf } from './capabilities';

function connector(overrides: Partial<Connector> = {}): Connector {
  return {
    key: 'test',
    displayName: 'Test',
    configSchema: { type: 'object', properties: {} },
    capabilities: [],
    ...overrides,
  };
}

describe('capability declarations', () => {
  it('maps every capability to a method', () => {
    // A capability with no method behind it could never be enforced.
    for (const capability of CAPABILITIES) {
      expect(CAPABILITY_METHODS[capability]).toBeTruthy();
    }
    expect(Object.keys(CAPABILITY_METHODS).sort()).toEqual([...CAPABILITIES].sort());
  });

  it('accepts a connector whose declarations match its methods', () => {
    const c = connector({
      capabilities: ['listing.quantity'],
      updateQuantity: async () => undefined,
    });
    expect(validateConnector(c)).toEqual([]);
  });

  it('rejects a capability with no implementation behind it', () => {
    const c = connector({ capabilities: ['listing.quantity'] });
    const problems = validateConnector(c);
    expect(problems.map((p) => p.code)).toContain('missing_method');
    expect(problems[0]?.message).toMatch(/updateQuantity/);
  });

  it('holds discovery to the same rule as every other capability', () => {
    const c = connector({ capabilities: ['listing.enumerate'] });
    const problems = validateConnector(c);
    expect(problems.map((p) => p.code)).toContain('missing_method');
    expect(problems[0]?.message).toMatch(/enumerateListings/);
  });

  /**
   * Enumeration deliberately does not affect `syncMode`. It says nothing about
   * how fresh a channel's *orders* are, and letting it promote a manual channel
   * to "continuous" would make reconciliation treat expected staleness as drift.
   */
  it('does not change sync mode', () => {
    expect(syncModeOf(['listing.enumerate'])).toBe('outbound-only');
    expect(syncModeOf(['orders.import', 'listing.enumerate'])).toBe('manual');
    expect(syncModeOf(['orders.webhook', 'listing.enumerate'])).toBe('continuous');
  });

  /**
   * The reverse case matters just as much: the core dispatches on capabilities,
   * so an implemented-but-undeclared method is dead code that an author almost
   * certainly believes is running.
   */
  it('rejects a method that is implemented but not declared', () => {
    const c = connector({ capabilities: [], updateQuantity: async () => undefined });
    const problems = validateConnector(c);
    expect(problems.map((p) => p.code)).toContain('undeclared_method');
    expect(problems[0]?.message).toMatch(/never call it/);
  });

  it('rejects an unknown capability string', () => {
    const c = connector({ capabilities: ['listing.teleport' as never] });
    expect(validateConnector(c).map((p) => p.code)).toContain('unknown_capability');
  });

  it('requires signature verification alongside a webhook endpoint', () => {
    const withoutVerify = connector({
      capabilities: ['orders.webhook'],
      parseWebhook: () => [],
    });
    const problems = validateConnector(withoutVerify);
    expect(problems.map((p) => p.message).join(' ')).toMatch(/verifyWebhook/);

    const withVerify = connector({
      capabilities: ['orders.webhook'],
      parseWebhook: () => [],
      verifyWebhook: () => true,
    });
    expect(validateConnector(withVerify)).toEqual([]);
  });

  it('rejects a definition missing its identity', () => {
    const problems = validateConnector({ ...connector(), key: '' });
    expect(problems.map((p) => p.code)).toContain('invalid_definition');
  });

  it('throws with every problem listed at once', () => {
    const c = connector({ capabilities: ['listing.push', 'reconcile'] });
    expect(() => assertValidConnector(c)).toThrow(/pushListing/);
    expect(() => assertValidConnector(c)).toThrow(/fetchLiveState/);
  });
});

describe('sync mode', () => {
  it('derives freshness from capabilities rather than configuration', () => {
    expect(syncModeOf(['orders.webhook'])).toBe('continuous');
    expect(syncModeOf(['orders.poll'])).toBe('polled');
    expect(syncModeOf(['orders.import'])).toBe('manual');
    expect(syncModeOf(['listing.push'])).toBe('outbound-only');
    expect(syncModeOf([])).toBe('outbound-only');
  });

  it('prefers the freshest inbound path a connector offers', () => {
    // A connector with both should not be treated as merely polled.
    expect(syncModeOf(['orders.poll', 'orders.webhook'])).toBe('continuous');
    expect(syncModeOf(['orders.import', 'orders.poll'])).toBe('polled');
  });

  it('identifies channels that depend on a human moving files', () => {
    expect(isManualChannel(['orders.import', 'listing.export'])).toBe(true);
    expect(isManualChannel(['orders.webhook'])).toBe(false);
  });

  it('reads the mode straight off a connector', () => {
    const c = connector({
      capabilities: ['orders.import'],
      importOrders: async () => ({ records: [], problems: [] }),
    });
    expect(connectorSyncMode(c)).toBe('manual');
  });
});

/**
 * ADR 0002: a file-based channel is a first-class connector, not a degraded
 * one. It declares no live capability at all and must still validate.
 */
describe('file-based connectors', () => {
  it('validates a connector that only exports and imports files', () => {
    const c = connector({
      key: 'tcgplayer',
      capabilities: ['listing.export', 'orders.import', 'inventory.import'],
      exportListings: async () => ({
        filename: 'listings.csv',
        contentType: 'text/csv',
        content: Buffer.alloc(0),
      }),
      importOrders: async () => ({ records: [], problems: [] }),
      importInventory: async () => ({ records: [], problems: [] }),
    });

    expect(validateConnector(c)).toEqual([]);
    expect(connectorSyncMode(c)).toBe('manual');
  });
});
