import { describe, expect, it } from 'vitest';
import { validateConnector, connectorSyncMode, type Connector } from '@hub/connector-sdk';
import { createShopifyConnector } from '@hub/connector-shopify';
import { ConnectorRegistry } from './connector-registry.service';

/**
 * Every bundled connector must satisfy the same contract community ones do.
 *
 * The registry validates on registration, so a broken bundled connector already
 * fails the boot — but that failure would surface as a container crash-looping
 * in CI's Docker job rather than as a named test. This says which connector and
 * why.
 */

const BUNDLED: Array<[string, () => Connector]> = [['shopify', () => createShopifyConnector()]];

describe.each(BUNDLED)('bundled connector: %s', (_name, make) => {
  it('passes SDK validation', () => {
    expect(validateConnector(make())).toEqual([]);
  });

  it('registers without complaint', () => {
    const registry = new ConnectorRegistry();
    expect(() => registry.register(make())).not.toThrow();
  });

  it('keeps secrets out of its config schema', () => {
    const connector = make();
    const properties = Object.keys(connector.configSchema.properties ?? {});
    for (const secret of connector.secretFields ?? []) {
      expect(properties).not.toContain(secret);
    }
  });

  it('declares a rate limit, since the core enforces rather than guesses', () => {
    expect(make().rateLimit?.requestsPerSecond).toBeGreaterThan(0);
  });
});

describe('Shopify connector registration', () => {
  it('is continuous-sync, being webhook-driven', () => {
    // ADR 0002: the only continuously synced channel in v1.
    expect(connectorSyncMode(createShopifyConnector())).toBe('continuous');
  });

  it('requires the location that scopes all its inventory calls', () => {
    // Shopify tracks inventory per location and the core model has no location
    // dimension, so the channel must be told which one it owns (ADR 0001 §5).
    expect(createShopifyConnector().configSchema.required).toContain('locationId');
  });

  it('is resolvable from the registry by the key stored on ChannelInstance', () => {
    const registry = new ConnectorRegistry();
    registry.register(createShopifyConnector());

    expect(registry.get('shopify').displayName).toBe('Shopify');
    expect(registry.supports('shopify', 'orders.webhook')).toBe(true);
    expect(registry.supports('shopify', 'orders.import')).toBe(false);
  });
});
